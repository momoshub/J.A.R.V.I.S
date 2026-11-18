import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MCP_SCHEMA_CACHE_DIR, createClaudeJsonReader, stdioServersFor, type StdioServer } from "../llm/mcpConfig.ts";
import {
  MCP_CLI_HELP,
  firstLine,
  headOf,
  mcpCallRefusal,
  parseFields,
  payloadOf,
  projectFields,
  rowCountOf,
  searchTools,
  toolInfoOf,
  type CallPayload,
  type SearchHit,
  type ToolInfo,
} from "../../domain/mcpCodeMode.ts";
import { exposedTools } from "../../domain/mcpApproval.ts";
import { approvalsPath, createFileApprovalStore } from "./approvals.ts";
import { createFileSchemaCache, createLazyProxy, schemaCachePath, spawnStdioServer, type JsonRpc } from "./lazyProxy.ts";

/**
 * The `mcp` code-mode CLI (`bin/mcp.ts`), after Uber's MCP Gateway `list / search / call`: instead of loading a
 * server's tools into the model's context and pulling every result through it, the model asks for a tool from the
 * shell, the full result goes to a file, and only a path, a size and a short head come back. The servers, their
 * command and env are the bot's own (`~/.claude.json` through `stdioServersFor`), the tool lists come from the lazy
 * proxy's schema cache, and a call runs through the same proxy, so the owner's tool approvals apply here too.
 */

export type CliIo = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly now?: () => Date;
};

const DEFAULT_CALL_TIMEOUT_S = 120;

/** `--name value` pairs out of the argument list, and what is left. */
const splitFlags = (argv: readonly string[], names: readonly string[]): { flags: Record<string, string>; rest: string[] } => {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--") && names.includes(a.slice(2))) {
      flags[a.slice(2)] = argv[i + 1] ?? "";
      i++;
    } else rest.push(a);
  }
  return { flags, rest };
};

type Loaded = { readonly name: string; readonly def: StdioServer; readonly tools: readonly ToolInfo[] | undefined; readonly hidden: number; readonly listed: readonly string[] };

/** A server's tools as a turn may see them: the cached list minus what the owner has not approved. */
const loadServer = (cacheDir: string, name: string, def: StdioServer): Loaded => {
  const cached = createFileSchemaCache(schemaCachePath(cacheDir, name, [def.command, ...def.args])).read();
  if (!cached) return { name, def, tools: undefined, hidden: 0, listed: [] };
  const state = createFileApprovalStore(approvalsPath(cacheDir, name)).read();
  // No baseline yet: the proxy takes the cached list as it is on its first run.
  const shown = state ? exposedTools(state, cached.tools) : cached.tools;
  return { name, def, tools: shown.flatMap((t) => toolInfoOf(t) ?? []), hidden: cached.tools.length - shown.length, listed: cached.tools.flatMap((t) => toolInfoOf(t)?.name ?? []) };
};

const callServer = async (
  cacheDir: string,
  server: Loaded,
  tool: string,
  args: unknown,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> => {
  const { name, def } = server;
  const command = [def.command, ...def.args];
  let settle: (m: JsonRpc) => void = () => {};
  const answer = new Promise<JsonRpc>((resolve) => (settle = resolve));
  const proxy = createLazyProxy({
    cache: createFileSchemaCache(schemaCachePath(cacheDir, name, command)),
    approvals: createFileApprovalStore(approvalsPath(cacheDir, name)),
    server: name,
    // The same command and env the bot launches the server with: the turn's environment under the server's own `env`.
    spawn: () => spawnStdioServer(command, { ...env, ...def.env }),
    out: (m) => void (m.id === 2 && settle(m)),
    log: (line) => log(`[${name}] ${line}`),
  });
  const timer = setTimeout(() => settle({ jsonrpc: "2.0", id: 2, error: { code: -32001, message: `no answer within ${timeoutMs / 1000}s` } }), timeoutMs);
  try {
    await proxy.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "jarvis-mcp-cli", version: "1" } },
    });
    await proxy.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    void proxy.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
    const reply = await answer;
    if (reply.error && typeof reply.error === "object") return { ok: false, error: String((reply.error as { message?: unknown }).message ?? "the call failed") };
    return { ok: true, result: reply.result };
  } finally {
    clearTimeout(timer);
    proxy.close();
  }
};

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");

const render = (payload: CallPayload): { text: string; ext: string } =>
  payload.kind === "text" ? { text: payload.text, ext: "txt" } : { text: JSON.stringify(payload.value, null, 1), ext: "json" };

export const runMcpCli = async (argv: readonly string[], io: CliIo): Promise<number> => {
  const { flags, rest } = splitFlags(argv, ["claude-json", "cache-dir", "fields", "out", "timeout"]);
  const [command, ...args] = rest;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.out(MCP_CLI_HELP);
    return command ? 0 : 2;
  }
  const cacheDir = flags["cache-dir"] || DEFAULT_MCP_SCHEMA_CACHE_DIR;
  const read = createClaudeJsonReader(flags["claude-json"] || undefined);
  const { stdio, other } = stdioServersFor(read(), io.cwd);
  const servers = Object.entries(stdio).map(([name, def]) => loadServer(cacheDir, name, def));
  const fail = (line: string): number => {
    io.err(`mcp: ${line}`);
    return 1;
  };

  if (command === "list") {
    if (servers.length === 0 && other.length === 0) return fail("no MCP servers are configured");
    for (const s of servers) {
      io.out(
        s.tools
          ? `${s.name}  ${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}${s.hidden ? `  (${s.hidden} waiting for the owner's approval)` : ""}`
          : `${s.name}  no schema cache yet (a call starts it and fills the cache)`,
      );
    }
    for (const name of other) io.out(`${name}  not reachable from the shell (http/sse server, only the CLI can connect to it)`);
    return 0;
  }

  if (command === "search") {
    const query = args.join(" ").trim();
    if (!query) return fail("usage: mcp search <query>");
    const index: SearchHit[] = servers.flatMap((s) => (s.tools ?? []).map((tool) => ({ server: s.name, tool })));
    const hits = searchTools(index, query);
    if (hits.length === 0) return fail(`nothing matches "${query}" (${index.length} tools searched; a server with no schema cache is not searched)`);
    for (const h of hits) io.out(`${h.server} ${h.tool.name}  ${firstLine(h.tool.description)}`);
    return 0;
  }

  if (command === "schema" || command === "call") {
    const [serverName, toolName, argText] = args;
    if (!serverName || !toolName) return fail(command === "schema" ? "usage: mcp schema <server> <tool>" : "usage: mcp call <server> <tool> '<json args>' [--fields a,b.c]");
    const server = servers.find((s) => s.name === serverName);
    if (!server) return fail(`unknown server "${serverName}". \`mcp list\` shows the ones this host has.`);
    if (command === "schema") {
      const tool = server.tools?.find((t) => t.name === toolName);
      if (!tool) return fail(server.tools ? `"${serverName}" lists no tool "${toolName}" for you (\`mcp search\` finds one)` : `"${serverName}" has no schema cache yet`);
      io.out(JSON.stringify(tool.inputSchema ?? {}, null, 2));
      return 0;
    }

    // The turn's role: refuse here what the turn's own --disallowedTools would refuse.
    const refusal = mcpCallRefusal(io.env, serverName, toolName);
    if (refusal) return fail(`refused: ${refusal}`);
    // A tool the cache lists but the owner has not approved is refused by the proxy below; one it does not list at all is a typo.
    if (server.tools && !server.listed.includes(toolName)) return fail(`"${serverName}" lists no tool "${toolName}" (\`mcp search\` finds one)`);
    let callArgs: unknown = {};
    if (argText) {
      try {
        callArgs = JSON.parse(argText);
      } catch {
        return fail("the arguments must be one JSON object, e.g. '{\"sql\":\"select 1\"}'");
      }
      if (!callArgs || typeof callArgs !== "object" || Array.isArray(callArgs)) return fail("the arguments must be one JSON object");
    }
    const fields = flags.fields ? parseFields(flags.fields) : [];
    const seconds = Number(flags.timeout ?? DEFAULT_CALL_TIMEOUT_S);
    if (!Number.isFinite(seconds) || seconds <= 0) return fail("--timeout is a number of seconds");

    const called = await callServer(cacheDir, server, toolName, callArgs, io.env, seconds * 1000, (line) => io.err(line));
    if (!called.ok) return fail(called.error);
    const result = called.result as { isError?: unknown } | undefined;
    const isError = result?.isError === true;
    const whole = payloadOf(called.result);
    // Projection only means something for JSON; a text or raw result is written whole.
    const payload: CallPayload = fields.length > 0 && whole.kind === "json" ? { kind: "json", value: projectFields(whole.value, fields) } : whole;
    const note = fields.length > 0 && whole.kind !== "json" ? "  (--fields ignored: the result is not JSON)" : "";

    const { text, ext } = render(payload);
    const dir = flags.out || join(tmpdir(), "jarvis-mcp-out");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${serverName}-${toolName}-${stamp((io.now ?? (() => new Date()))())}-${Math.random().toString(36).slice(2, 6)}.${ext}`.replace(/[^A-Za-z0-9_.-]/g, "_"));
    writeFileSync(file, text, { mode: 0o600 });

    const rows = payload.kind === "json" ? rowCountOf(payload.value) : undefined;
    io.out(`${isError ? "the tool reported an error; " : ""}result: ${file}`);
    io.out(`size: ${Buffer.byteLength(text)} bytes${rows ? `, ${rows.rows} rows${rows.where ? ` (${rows.where})` : ""}` : ""}${fields.length > 0 ? `, projected to ${fields.join(",")}` : ""}${note}`);
    io.out(`head: ${headOf(payload)}`);
    return isError ? 1 : 0;
  }

  return fail(`unknown command "${command}". ${MCP_CLI_HELP.split("\n")[0]}`);
};
