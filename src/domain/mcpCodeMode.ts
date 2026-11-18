/**
 * Pure parts of the `mcp` code-mode CLI (`bin/mcp.ts`): a turn lists, searches and
 * calls MCP tools from the shell, the full result lands in a file, and only a
 * short summary comes back into the model's context. Response projection
 * (`--fields`) cuts the result down before it is written.
 */

/** A turn's access, set in its environment when the CLI spawns it (`turnMcpEnv`). */
export const MCP_ACCESS_ENV = "BOT_MCP_ACCESS";
/** JSON array of the turn's `mcp__...` entries of `--disallowedTools`. */
export const MCP_DENY_ENV = "BOT_MCP_DENY";

export type TurnPolicyLike = { readonly skipPermissions: boolean; readonly disallowedTools?: readonly string[] };

/**
 * What the CLI needs to enforce the turn's role from inside a Bash call: whether the turn runs with full access
 * (the only kind that can reach this CLI, since a sandboxed role's allow-list has no entry for it) and the MCP
 * servers and tools the turn is denied.
 */
export const turnMcpEnv = (policy: TurnPolicyLike): Record<string, string> => ({
  [MCP_ACCESS_ENV]: policy.skipPermissions ? "full" : "sandbox",
  [MCP_DENY_ENV]: JSON.stringify((policy.disallowedTools ?? []).filter((t) => t.startsWith("mcp__"))),
});

/**
 * Why the CLI refuses a call, or undefined when it may go ahead. Outside a turn (no access variable: the owner at
 * a terminal) it is allowed; in a turn it needs full access and must not be denied the server or the tool.
 */
export const mcpCallRefusal = (env: Readonly<Record<string, string | undefined>>, server: string, tool: string): string | undefined => {
  const access = env[MCP_ACCESS_ENV];
  if (access === undefined) return undefined;
  if (access !== "full") return "this turn's role has no full access, and the mcp CLI is for the owner / full-access turns only";
  let denied: unknown;
  try {
    denied = JSON.parse(env[MCP_DENY_ENV] ?? "[]");
  } catch {
    return "this turn's MCP deny list is unreadable, so the call is refused";
  }
  if (!Array.isArray(denied)) return "this turn's MCP deny list is unreadable, so the call is refused";
  const names = [server, server.replace(/[^A-Za-z0-9_-]/g, "_")];
  const matches = (candidates: readonly string[]): boolean => denied.some((d) => typeof d === "string" && candidates.some((c) => denyPatternMatches(d, c)));
  if (matches(names.map((n) => `mcp__${n}`))) return `this turn may not use the \`${server}\` MCP server (it is in the turn's disallowed tools)`;
  if (matches(names.map((n) => `mcp__${n}__${tool}`))) return `this turn may not call \`${tool}\` of \`${server}\` (it is in the turn's disallowed tools)`;
  return undefined;
};

/** A `--disallowedTools` entry against a tool name: exact, or with `*` standing for any run of characters (`mcp__db__*`, `mcp__db__drop_*`). */
const denyPatternMatches = (pattern: string, name: string): boolean =>
  pattern === name || (pattern.includes("*") && new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(name));

/** Dotted paths from a `--fields a,b.c` value. */
export const parseFields = (raw: string): string[] => raw.split(",").map((f) => f.trim()).filter(Boolean);

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);

const projectPaths = (value: Json, paths: readonly (readonly string[])[]): Json => {
  if (Array.isArray(value)) return value.map((v) => projectPaths(v, paths));
  if (!isObject(value)) return undefined;
  const out: Record<string, Json> = {};
  for (const key of new Set(paths.map((p) => p[0]!))) {
    if (!Object.hasOwn(value, key)) continue;
    const tails = paths.filter((p) => p[0] === key).map((p) => p.slice(1));
    // A path that ends here keeps the whole value; otherwise keep digging with what is left of the paths.
    const kept = tails.some((t) => t.length === 0) ? value[key] : projectPaths(value[key], tails);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
};

/**
 * Keeps only the dotted `fields` of a JSON value. Arrays are walked through, so `rows.name` keeps `name` of every
 * element of `rows`; a path that matches nothing is dropped. A scalar at the top has nothing to project and is returned as is.
 */
export const projectFields = (value: Json, fields: readonly string[]): Json => {
  const paths = fields.map((f) => f.split(".").filter(Boolean)).filter((p) => p.length > 0);
  if (paths.length === 0) return value;
  return Array.isArray(value) || isObject(value) ? projectPaths(value, paths) : value;
};

/** The payload of an MCP `tools/call` result, as it is worth storing. */
export type CallPayload =
  | { kind: "json"; value: Json }
  | { kind: "text"; text: string }
  | { kind: "raw"; value: Json };

/** structuredContent first, else the text blocks (parsed as JSON when they are), else the whole result (images etc.). */
export const payloadOf = (result: Json): CallPayload => {
  if (!isObject(result)) return { kind: "raw", value: result };
  if (result.structuredContent !== undefined) return { kind: "json", value: result.structuredContent };
  const content = Array.isArray(result.content) ? result.content : [];
  const texts = content.flatMap((c) => (isObject(c) && c.type === "text" && typeof c.text === "string" ? [c.text] : []));
  if (content.length === 0 || texts.length !== content.length) return { kind: "raw", value: result };
  const text = texts.join("\n");
  try {
    return { kind: "json", value: JSON.parse(text) as Json };
  } catch {
    return { kind: "text", text };
  }
};

/** The row count worth reporting: a top-level array, or the longest array one level down (`{rows: [...]}`). */
export const rowCountOf = (value: Json): { rows: number; where?: string } | undefined => {
  if (Array.isArray(value)) return { rows: value.length };
  if (!isObject(value)) return undefined;
  let best: { rows: number; where: string } | undefined;
  for (const [key, v] of Object.entries(value)) if (Array.isArray(v) && (!best || v.length > best.rows)) best = { rows: v.length, where: key };
  return best;
};

/** A one-line look at the start of a payload (the first three rows of a list), cut at `max` characters. */
export const headOf = (payload: CallPayload, max = 600): string => {
  const first = (v: Json): Json =>
    Array.isArray(v) ? v.slice(0, 3) : isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Array.isArray(x) ? x.slice(0, 3) : x])) : v;
  const text = payload.kind === "text" ? payload.text : JSON.stringify(first(payload.value));
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
};

/** One tool as the cache lists it. */
export type ToolInfo = { readonly name: string; readonly description: string; readonly inputSchema?: unknown };

export const toolInfoOf = (tool: unknown): ToolInfo | undefined => {
  if (!isObject(tool) || typeof tool.name !== "string") return undefined;
  const description = typeof tool.description === "string" ? tool.description : "";
  return { name: tool.name, description, ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}) };
};

/** The description's first non-empty line, for one-line listings. */
export const firstLine = (text: string, max = 100): string => {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
};

export type SearchHit = { readonly server: string; readonly tool: ToolInfo };

/** Every word of the query must appear in the server, tool name or description (case-insensitive); name matches rank first. */
export const searchTools = (index: readonly SearchHit[], query: string): SearchHit[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const score = (h: SearchHit): number => {
    const name = `${h.server} ${h.tool.name}`.toLowerCase();
    if (!words.every((w) => `${name} ${h.tool.description.toLowerCase()}`.includes(w))) return 0;
    return words.every((w) => name.includes(w)) ? 2 : 1;
  };
  return index
    .map((h) => ({ h, s: score(h) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || `${a.h.server}/${a.h.tool.name}`.localeCompare(`${b.h.server}/${b.h.tool.name}`))
    .map((x) => x.h);
};

export const MCP_CLI_HELP = `mcp - call MCP tools from the shell; the full result goes to a file, only a short summary comes back

  mcp list                                   servers and how many tools each has (from the schema cache, nothing is started)
  mcp search <query>                         tools whose name or description match every word, one line each
  mcp schema <server> <tool>                 the tool's input schema
  mcp call <server> <tool> '<json args>' [--fields a,b.c] [--out <dir>] [--timeout <seconds>]
                                             start the server, call the tool, write the whole result to a file and print
                                             its path, size and row count and a short head. --fields keeps only those dotted
                                             paths of a JSON result (arrays are walked: rows.name = name of every row)

Then grep or jq the file instead of reading it whole. Tools the owner has not approved yet (mcp-tools pending) are not listed and cannot be called.
Options anywhere: --claude-json <file> (default ~/.claude.json), --cache-dir <dir> (default ~/.jarvis/mcp-schema-cache).`;
