import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A stdio MCP proxy that connects lazily. The CLI starts every `--mcp-config`
 * server at turn start, and a database server (dbhub measured 9.7s alone, three
 * of them plus uvx timing out at 30s together) made a trivial chat turn wait for
 * servers it never uses. The proxy answers `initialize` and `tools/list` from a
 * schema cached on disk and starts the real server only on the first request
 * that needs it (`tools/call`, resources, prompts). Every spawn refreshes the
 * cache, so a server whose tools changed is picked up the next turn.
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
  let real: RealServer | undefined;
  let ready: Promise<Ready> | undefined;
  // Responses the proxy itself asked the real server for, by id.
  const waiting = new Map<string, (m: JsonRpc) => void>();
  // Client requests forwarded and not yet answered, so a dying server fails them instead of hanging the turn.
  const forwarded = new Set<unknown>();

  const ask = (server: RealServer, id: string, method: string, params?: JsonRpc): Promise<JsonRpc> =>
    new Promise((resolve) => {
      waiting.set(id, resolve);
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

  const onRealExit = (): void => {
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
    server.onExit(onRealExit);
    const started = (async (): Promise<Ready> => {
      const params = isRecord(clientInit?.params)
        ? clientInit.params
        : { protocolVersion: DEFAULT_PROTOCOL, capabilities: {}, clientInfo: { name: "lazy-proxy", version: "0" } };
      const res = await ask(server, INIT_ID, "initialize", params);
      if (!isRecord(res.result)) throw new Error(`the MCP server did not initialize: ${JSON.stringify(res.error ?? res)}`);
      const initialize = res.result;
      server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const schema = readSchema(server, initialize);
      void schema.then(
        (full) => {
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

  const forward = async (msg: JsonRpc): Promise<void> => {
    try {
      await connect();
    } catch (e) {
      out(fail(msg.id, String(e instanceof Error ? e.message : e)));
      return;
    }
    if (hasId(msg)) forwarded.add(msg.id);
    real?.send(msg);
  };

  const handleRequest = async (msg: JsonRpc): Promise<void> => {
    const { id } = msg;
    if (msg.method === "ping") return out(reply(id, {}));
    if (msg.method === "initialize") {
      clientInit = msg;
      const cached = cache.read();
      if (cached) return out(reply(id, cached.initialize));
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
      if (items) return out(reply(id, { [list.key]: items }));
      // No cache, or a list it never recorded: only the real server knows.
      try {
        const full = await (await connect()).schema;
        return out(reply(id, { [list.key]: (method === "tools/list" ? full.tools : full.lists?.[method]) ?? [] }));
      } catch (e) {
        return out(fail(id, String(e instanceof Error ? e.message : e)));
      }
    }
    if (NEEDS_SERVER.test(method)) return forward(msg);
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
      // Cancellations and the like only mean something to a server that is running.
      real?.send(msg);
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
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(schema));
    renameSync(tmp, path);
  },
});

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
