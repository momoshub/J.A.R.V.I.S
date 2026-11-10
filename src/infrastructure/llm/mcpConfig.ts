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

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

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
): string | undefined => {
  const root = asRecord(claudeJson);
  if (!root) return undefined;
  const user = asRecord(root.mcpServers);
  const project = cwd ? asRecord(asRecord(asRecord(root.projects)?.[cwd])?.mcpServers) : undefined;
  if (!user && !project) return undefined;
  const merged: Servers = { ...user, ...project };
  for (const name of deny) delete merged[name];
  return JSON.stringify({ mcpServers: merged });
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
