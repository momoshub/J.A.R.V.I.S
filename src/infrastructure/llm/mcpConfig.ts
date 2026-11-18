import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * MCP servers a bot turn must NOT load: the ones registered on the host that
 * are not authenticated. The CLI injects a "needs authentication" notice
 * mid-turn for each, and the model wrote that notice into a Slack reply
 * instead of its answer (datadog and figma, 2026-11-09). Static on purpose -
 * auth status is not probed per spawn. Take `datadog` off this list once a
 * human has completed its OAuth (`claude mcp list` stops saying "Needs
 * authentication"), and add any server that starts showing the same notice.
 */
export const UNAUTHENTICATED_MCP_SERVERS: readonly string[] = ["figma", "datadog"];

/** Set on a spawn so the CLI does not load the account's claude.ai connectors. */
export const NO_CLAUDEAI_CONNECTORS_ENV = { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } as const;

type Servers = Record<string, unknown>;

/** Where each stdio server's cached schema (and its tool approvals) lives unless the host says otherwise. */
export const DEFAULT_MCP_SCHEMA_CACHE_DIR = join(homedir(), ".jarvis", "mcp-schema-cache");

/** How a stdio server is wrapped in the lazy proxy (`bin/mcp-lazy-proxy.ts`). */
export type LazyProxy = {
  /** The runtime that runs the proxy script (bun). */
  readonly runtime: string;
  readonly script: string;
  /** Where each server's cached schema lives. */
  readonly cacheDir: string;
};

export type McpConfigOptions = {
  /** Wrap every stdio server in the lazy proxy so none starts before a tool is called. */
  readonly lazy?: LazyProxy;
  /** The turn's `--disallowedTools`: a whole-server entry (`mcp__name`) keeps that server out of the config. */
  readonly disallowedTools?: readonly string[];
};

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** User-scope servers plus the project-scope ones for `cwd`, minus `deny`. Undefined when the file holds no server list. */
const mergedServers = (claudeJson: unknown, cwd: string | undefined, deny: readonly string[]): Servers | undefined => {
  const root = asRecord(claudeJson);
  if (!root) return undefined;
  const user = asRecord(root.mcpServers);
  const project = cwd ? asRecord(asRecord(asRecord(root.projects)?.[cwd])?.mcpServers) : undefined;
  if (!user && !project) return undefined;
  const merged: Servers = { ...user, ...project };
  for (const name of deny) delete merged[name];
  return merged;
};

/** A stdio server as the bot launches it: the same command, args and env the lazy proxy wraps. */
export type StdioServer = { readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> };

/**
 * The stdio servers a turn would get (`mcpConfigFor` without the proxy and the role filter), by name, plus the names
 * of the ones it cannot run itself (http, sse: their auth lives in the CLI). Used by the `mcp` code-mode CLI.
 */
export const stdioServersFor = (
  claudeJson: unknown,
  cwd: string | undefined,
  deny: readonly string[] = UNAUTHENTICATED_MCP_SERVERS,
): { stdio: Record<string, StdioServer>; other: string[] } => {
  const stdio: Record<string, StdioServer> = {};
  const other: string[] = [];
  for (const [name, def] of Object.entries(mergedServers(claudeJson, cwd, deny) ?? {})) {
    const d = asRecord(def);
    if (!d || typeof d.command !== "string" || (d.type !== undefined && d.type !== "stdio")) {
      other.push(name);
      continue;
    }
    const env = Object.fromEntries(Object.entries(asRecord(d.env) ?? {}).map(([k, v]) => [k, String(v)]));
    stdio[name] = { command: d.command, args: Array.isArray(d.args) ? d.args.map(String) : [], env };
  }
  return { stdio, other };
};

/**
 * The `--mcp-config` JSON for a turn: every user-scope server in `~/.claude.json`
 * plus the project-scope ones for `cwd`, minus `deny`. A denylist rather than an
 * allowlist, so a server added to the host later keeps loading with no code
 * change. Undefined when the file holds no usable server list - the caller then
 * leaves MCP config alone rather than strictly loading nothing.
 */
export const mcpConfigFor = (
  claudeJson: unknown,
  cwd: string | undefined,
  deny: readonly string[] = UNAUTHENTICATED_MCP_SERVERS,
  opts: McpConfigOptions = {},
): string | undefined => {
  const merged = mergedServers(claudeJson, cwd, deny);
  if (!merged) return undefined;
  // A server the role may not call has no business being started: drop it, not just its tools.
  for (const tool of opts.disallowedTools ?? []) if (tool.startsWith("mcp__") && !tool.includes("__", 5)) delete merged[tool.slice(5)];
  const { lazy } = opts;
  if (lazy) for (const [name, def] of Object.entries(merged)) merged[name] = lazyStdio(name, def, lazy);
  return JSON.stringify({ mcpServers: merged });
};

/** A stdio definition run through the lazy proxy; anything else (http, sse) is returned as it was. */
const lazyStdio = (name: string, def: unknown, lazy: LazyProxy): unknown => {
  const d = asRecord(def);
  if (!d || typeof d.command !== "string" || (d.type !== undefined && d.type !== "stdio")) return def;
  const args = Array.isArray(d.args) ? d.args.map(String) : [];
  return {
    ...d,
    type: "stdio",
    command: lazy.runtime,
    // --no-env-file: bun would otherwise load a .env from the turn's cwd and hand it to the real server.
    args: ["--no-env-file", lazy.script, "--name", name, "--cache-dir", lazy.cacheDir, "--", d.command, ...args],
  };
};

/**
 * Local stdio servers in `~/.claude.json` (user scope) that `DB_MCP_SERVERS`
 * does not name. A database server missing from that list is reachable by
 * every role, so the host logs these at boot: some may be harmless, but each
 * one is worth a look. Names may be given with or without the `mcp__` prefix.
 */
export const unlistedLocalMcpServers = (claudeJson: unknown, dbServers: readonly string[]): string[] => {
  const user = asRecord(asRecord(claudeJson)?.mcpServers);
  if (!user) return [];
  const listed = new Set(dbServers.map((n) => n.trim().replace(/^mcp__/, "")));
  return Object.entries(user)
    .filter(([name, def]) => typeof asRecord(def)?.command === "string" && !listed.has(name))
    .map(([name]) => name);
};

/**
 * Names that match no user-scope server in `~/.claude.json`. A name in a denylist
 * that matches nothing denies nothing, and the usual cause (a typo, a server
 * renamed on the host) is silent, so the host logs these at boot. Nothing when the
 * file holds no server list, since then nothing can be said.
 */
export const unknownMcpServers = (claudeJson: unknown, names: readonly string[]): string[] => {
  const user = asRecord(asRecord(claudeJson)?.mcpServers);
  if (!user) return [];
  return names.filter((n) => !Object.hasOwn(user, n));
};

/** `~/.claude.json`, re-read only when it changes. Never written. */
export const createClaudeJsonReader = (path: string = join(homedir(), ".claude.json")): (() => unknown) => {
  let cached: { stamp: string; value: unknown } | undefined;
  return () => {
    try {
      const st = statSync(path);
      const stamp = `${st.mtimeMs}:${st.size}`;
      if (cached?.stamp === stamp) return cached.value;
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      cached = { stamp, value };
      return value;
    } catch {
      return undefined;
    }
  };
};
