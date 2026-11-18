import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { awaitingApprovalMessage, baselineOf, exposedTools, isApproved, namesOf, type ApprovalState } from "../../domain/mcpApproval.ts";
import type { ApprovalStore } from "./approvals.ts";

/**
 * A stdio MCP proxy that connects lazily. The CLI starts every `--mcp-config`
 * server at turn start, and a database server (dbhub measured 9.7s alone, three
 * of them plus uvx timing out at 30s together) made a trivial chat turn wait for
 * servers it never uses. The proxy answers `initialize` and the list methods
 * (`tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`)
 * from a schema cached on disk and starts the real server only on the first
 * request that needs it (`tools/call`, resource reads, prompt gets). Every spawn
 * refreshes the cache, so a server whose tools changed is picked up on the next
 * turn after one that called it. An empty tool list is never cached, since with
 * no tools nothing would ever call the server to correct it.
 *
 * Discovery is not exposure: with an `approvals` store, a tool that is not in the
 * server's approved baseline is left out of `tools/list` and its `tools/call` is
 * refused until the owner approves it (`domain/mcpApproval.ts`).
 *
 * First run with no cache has nothing to answer from, so it spawns the real
 * server once, exactly like before, and writes the cache.
 */

export type JsonRpc = Record<string, unknown>;

export type SchemaCache = {
  read: () => CachedSchema | undefined;
  write: (schema: CachedSchema) => void;
};

export type CachedSchema = {
  /** The real server's `initialize` result (protocolVersion, capabilities, serverInfo). */
  readonly initialize: JsonRpc;
  /** Every tool the real server listed, all pages merged. */
  readonly tools: readonly unknown[];
  /** The other list methods the server advertises (`prompts/list`, `resources/list`, ...), pages merged. */
  readonly lists?: Readonly<Record<string, readonly unknown[]>>;
};

/** The paged list methods the proxy caches, and the result key each one's items sit under. */
const LISTS: Readonly<Record<string, { key: string; capability: string }>> = {
  "tools/list": { key: "tools", capability: "tools" },
  "prompts/list": { key: "prompts", capability: "prompts" },
  "resources/list": { key: "resources", capability: "resources" },
  "resources/templates/list": { key: "resourceTemplates", capability: "resources" },
};

/** Requests that only the real server can answer: calls and reads, not discovery. */
const NEEDS_SERVER = /^(tools\/call|resources\/|prompts\/|completion\/|logging\/|tasks\/)/;

/** The real server, as the proxy sees it: lines of JSON-RPC in and out. */
export type RealServer = {
  send: (msg: JsonRpc) => void;
  onMessage: (cb: (msg: JsonRpc) => void) => void;
  onExit: (cb: () => void) => void;
  kill: () => void;
};

export type ProxyDeps = {
  cache: SchemaCache;
  spawn: () => RealServer;
  /** To the client (the CLI). */
  out: (msg: JsonRpc) => void;
  log?: (line: string) => void;
  /** The server's name, for the message a refused call carries. */
  server?: string;
  /** Owner approval of tools. Absent: every tool the server lists is exposed. */
  approvals?: ApprovalStore;
  /** How long the real server may take to answer `initialize` before the start is given up. Default 30s, the CLI's own connect timeout. */
  startTimeoutMs?: number;
};

const INIT_ID = "lazy-proxy:init";
const listId = (method: string, page: number): string => `lazy-proxy:${method}:${page}`;
const DEFAULT_PROTOCOL = "2025-06-18";

const isRecord = (v: unknown): v is JsonRpc => !!v && typeof v === "object" && !Array.isArray(v);
const hasId = (m: JsonRpc): boolean => m.id !== undefined && m.id !== null;

const reply = (id: unknown, result: JsonRpc): JsonRpc => ({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, message: string, code = -32603): JsonRpc => ({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * Claude Code opens with a `server/discover` probe (the 2026-07-28 protocol) and
 * waits about 3s for an answer before it falls back to `initialize`. A server of
 * the handshake era refuses it with this error; the proxy says the same at once,
 * so the probe costs nothing and the real server is not started for it.
 */
const HANDSHAKE_ERA = "this connection serves the handshake protocol era; requests carrying the 2026-07-28 envelope are not accepted on it";

type Ready = { initialize: JsonRpc; schema: Promise<CachedSchema> };

export const createLazyProxy = (deps: ProxyDeps) => {
  const { cache, out } = deps;
  const log = deps.log ?? (() => {});
  let clientInit: JsonRpc | undefined;
  let clientReady = false;
  // The protocol version the client was told, which the real server is then initialized with.
  let announced: unknown;
  let real: RealServer | undefined;
  let ready: Promise<Ready> | undefined;
  // Responses the proxy itself asked the real server for, by id.
  const waiting = new Map<string, (m: JsonRpc) => void>();
  // Client requests forwarded and not yet answered, so a dying server fails them instead of hanging the turn.
  const forwarded = new Set<unknown>();

  const ask = (server: RealServer, id: string, method: string, params?: JsonRpc, timeoutMs?: number): Promise<JsonRpc> =>
    new Promise((resolve) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            waiting.delete(id);
            resolve({ jsonrpc: "2.0", error: { code: -32001, message: `no answer to ${method} within ${timeoutMs}ms` } });
          }, timeoutMs)
        : undefined;
      waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      server.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });

  const listAll = async (server: RealServer, method: string): Promise<readonly unknown[]> => {
    const items: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await ask(server, listId(method, page), method, cursor ? { cursor } : undefined);
      const result = isRecord(res.result) ? res.result : undefined;
      if (!result) throw new Error(`${method} failed`);
      const found = result[LISTS[method]!.key];
      if (Array.isArray(found)) items.push(...found);
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return items;
  };

  /** Everything a warm answer needs: the tool list (required) and each other list the server advertises (best effort). */
  const readSchema = async (server: RealServer, initialize: JsonRpc): Promise<CachedSchema> => {
    const caps = isRecord(initialize.capabilities) ? initialize.capabilities : {};
    const optional = Object.entries(LISTS).filter(([m, l]) => m !== "tools/list" && caps[l.capability] !== undefined);
    const [tools, ...rest] = await Promise.all([
      listAll(server, "tools/list"),
      ...optional.map(([m]) => listAll(server, m).catch((): readonly unknown[] => [])),
    ]);
    return { initialize, tools, lists: Object.fromEntries(optional.map(([m], i) => [m, rest[i] ?? []])) };
  };

  const onRealMessage = (msg: JsonRpc): void => {
    const waiter = typeof msg.id === "string" ? waiting.get(msg.id) : undefined;
    if (waiter && typeof msg.id === "string") {
      waiting.delete(msg.id);
      waiter(msg);
      return;
    }
    if (hasId(msg) && msg.method === undefined) forwarded.delete(msg.id);
    out(msg);
  };

  const onRealExit = (server: RealServer): void => {
    // A server already replaced or given up on exits late: that says nothing about the one running now.
    if (real !== server) return;
    real = undefined;
    ready = undefined;
    for (const resolve of waiting.values()) resolve({ jsonrpc: "2.0", error: { code: -32603, message: "server exited" } });
    waiting.clear();
    for (const id of forwarded) out(fail(id, "the MCP server exited before it answered"));
    forwarded.clear();
  };

  /** Starts the real server once, initializes it, and refreshes the cache in the background. */
  const connect = (): Promise<Ready> => {
    if (ready) return ready;
    const server = deps.spawn();
    real = server;
    server.onMessage(onRealMessage);
    server.onExit(() => onRealExit(server));
    const started = (async (): Promise<Ready> => {
      const base = isRecord(clientInit?.params)
        ? clientInit.params
        : { protocolVersion: DEFAULT_PROTOCOL, capabilities: {}, clientInfo: { name: "lazy-proxy", version: "0" } };
      // Speak the version the client was already promised from the cache, not the one it asked for.
      const params = typeof announced === "string" ? { ...base, protocolVersion: announced } : base;
      const res = await ask(server, INIT_ID, "initialize", params, deps.startTimeoutMs ?? 30000);
      if (!isRecord(res.result)) throw new Error(`the MCP server did not initialize: ${JSON.stringify(res.error ?? res)}`);
      const initialize = res.result;
      server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const schema = readSchema(server, initialize);
      void schema.then(
        (full) => {
          // No tools means nothing would ever call this server to correct the cache.
          if (full.tools.length === 0) return log("tool list is empty: cache left alone");
          try {
            cache.write(full);
          } catch (e) {
            log(`schema cache not written: ${String(e)}`);
          }
        },
        (e: unknown) => log(`schema refresh failed: ${String(e)}`),
      );
      return { initialize, schema };
    })();
    ready = started;
    // A server that never came up must be tried again by the next request, not remembered as dead.
    started.catch(() => {
      if (ready === started) {
        ready = undefined;
        real = undefined;
        server.kill();
      }
    });
    return started;
  };

  /**
   * The approval state, baselining the server on its first sight of a tool list.
   * Undefined when there is nothing to baseline from (no tools, or the server cannot be reached).
   */
  const approvalState = async (tools?: readonly unknown[]): Promise<ApprovalState | undefined> => {
    const store = deps.approvals;
    if (!store) return undefined;
    const existing = store.read();
    if (existing) return existing;
    let known = tools ?? cache.read()?.tools;
    if (!known) {
      try {
        known = (await (await connect()).schema).tools;
      } catch {
        return undefined;
      }
    }
    // No tools means no baseline: the first tools that show up would be taken as approved.
    if (known.length === 0) return undefined;
    const baseline = baselineOf(known);
    try {
      if (store.create(baseline)) {
        log(`first run: ${baseline.approved.length} tool(s) approved as the baseline`);
        return baseline;
      }
    } catch (e) {
      log(`approvals not written: ${String(e)}`);
      return undefined;
    }
    // Another process baselined at the same moment: its state is the one that counts.
    return store.read();
  };

  const gateList = async (tools: readonly unknown[]): Promise<readonly unknown[]> => {
    if (!deps.approvals) return tools;
    const state = await approvalState(tools);
    // Failing closed: with no state to judge by, nothing is exposed, unless the server lists nothing.
    if (!state) return tools.length === 0 ? tools : [];
    const shown = exposedTools(state, tools);
    if (shown.length < tools.length) {
      const hidden = namesOf(tools).filter((n) => !isApproved(state, n));
      log(`${hidden.length} tool(s) hidden until the owner approves them: ${hidden.join(", ")}`);
    }
    return shown;
  };

  const refuseUnapproved = async (msg: JsonRpc): Promise<boolean> => {
    if (!deps.approvals || msg.method !== "tools/call") return false;
    const name = isRecord(msg.params) && typeof msg.params.name === "string" ? msg.params.name : "";
    const state = await approvalState();
    if (state && isApproved(state, name)) return false;
    const text = awaitingApprovalMessage(deps.server ?? "this server", name);
    out(reply(msg.id, { content: [{ type: "text", text }], isError: true }));
    return true;
  };

  const forward = async (msg: JsonRpc): Promise<void> => {
    try {
      await connect();
    } catch (e) {
      out(fail(msg.id, String(e instanceof Error ? e.message : e)));
      return;
    }
    if (!real) {
      out(fail(msg.id, "the MCP server exited before it could be sent the request"));
      return;
    }
    if (hasId(msg)) forwarded.add(msg.id);
    real.send(msg);
  };

  const handleRequest = async (msg: JsonRpc): Promise<void> => {
    const { id } = msg;
    if (msg.method === "ping") return out(reply(id, {}));
    if (msg.method === "initialize") {
      clientInit = msg;
      const cached = cache.read();
      if (cached) {
        announced = cached.initialize.protocolVersion;
        return out(reply(id, cached.initialize));
      }
      try {
        return out(reply(id, (await connect()).initialize));
      } catch (e) {
        return out(fail(id, String(e instanceof Error ? e.message : e)));
      }
    }
    const method = String(msg.method);
    const list = LISTS[method];
    if (list) {
      const cached = cache.read();
      const items = method === "tools/list" ? cached?.tools : cached?.lists?.[method];
      if (items) return out(reply(id, { [list.key]: method === "tools/list" ? await gateList(items) : items }));
      // No cache, or a list it never recorded: only the real server knows.
      try {
        const full = await (await connect()).schema;
        const found = (method === "tools/list" ? full.tools : full.lists?.[method]) ?? [];
        return out(reply(id, { [list.key]: method === "tools/list" ? await gateList(found) : found }));
      } catch (e) {
        return out(fail(id, String(e instanceof Error ? e.message : e)));
      }
    }
    if (NEEDS_SERVER.test(method)) {
      if (await refuseUnapproved(msg)) return;
      return forward(msg);
    }
    // Discovery and anything else the handshake protocol does not have: a refusal, without a spawn.
    return out(fail(id, method.startsWith("server/") ? HANDSHAKE_ERA : `method not found: ${method}`, method.startsWith("server/") ? -32600 : -32601));
  };

  return {
    handle: (msg: JsonRpc): Promise<void> => {
      if (typeof msg.method !== "string") {
        // A response to a request the real server made of the client (sampling, roots): pass it on.
        if (hasId(msg)) real?.send(msg);
        return Promise.resolve();
      }
      if (hasId(msg)) return handleRequest(msg);
      if (msg.method === "notifications/initialized") {
        clientReady = true;
        return Promise.resolve();
      }
      // Cancellations and the like only mean something to a server that is running, and must land after the
      // initialize handshake and the request they refer to, so they queue behind the start in progress.
      const starting = ready;
      if (starting) void starting.then(() => real?.send(msg), () => {});
      return Promise.resolve();
    },
    close: (): void => real?.kill(),
    /** Test hook: has the client said it is ready, and is the real server running. */
    state: () => ({ clientReady, running: real !== undefined }),
  };
};

/** Cache file for one server: the name for humans, a hash of the launch line so an edited command starts clean. */
export const schemaCachePath = (dir: string, name: string, command: readonly string[]): string => {
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, "_");
  const hash = createHash("sha256").update(JSON.stringify(command)).digest("hex").slice(0, 12);
  return join(dir, `${safe}-${hash}.json`);
};

export const createFileSchemaCache = (path: string): SchemaCache => ({
  read: () => {
    try {
      const v: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(v) && isRecord(v.initialize) && Array.isArray(v.tools)) {
        const lists = isRecord(v.lists) ? (v.lists as Record<string, unknown[]>) : undefined;
        return { initialize: v.initialize, tools: v.tools, ...(lists ? { lists } : {}) };
      }
    } catch {
      // no cache yet, or an unreadable one: the real server answers instead
    }
    return undefined;
  },
  write: (schema) => {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(schema), { mode: 0o600 });
    renameSync(tmp, path);
  },
});

/** Starts a stdio MCP server and speaks newline-delimited JSON-RPC to it. */
export const spawnStdioServer = (command: readonly string[], env: Record<string, string | undefined> = process.env): RealServer => {
  const proc = Bun.spawn({ cmd: [...command], stdin: "pipe", stdout: "pipe", stderr: "inherit", env });
  let listener: (msg: JsonRpc) => void = () => {};
  const parse = createLineParser((m) => listener(m));
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of proc.stdout) parse(decoder.decode(chunk, { stream: true }));
  })();
  return {
    send: (msg) => {
      proc.stdin.write(`${JSON.stringify(msg)}\n`);
      void proc.stdin.flush();
    },
    onMessage: (cb) => {
      listener = cb;
    },
    onExit: (cb) => void proc.exited.then(cb),
    kill: () => proc.kill(),
  };
};

/** Splits a byte stream into newline-delimited JSON-RPC messages; lines that are not JSON objects are dropped. */
export const createLineParser = (onMessage: (msg: JsonRpc) => void) => {
  let buffer = "";
  return (chunk: string): void => {
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      try {
        const v: unknown = JSON.parse(line);
        if (isRecord(v)) onMessage(v);
      } catch {
        // not JSON-RPC (a stray log line on stdout): nothing to route
      }
    }
  };
};
