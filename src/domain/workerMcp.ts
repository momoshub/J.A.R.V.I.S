/**
 * Keeping the host's MCP servers out of Orca workers.
 *
 * Every `claude` session loads every user-scope server in `~/.claude.json`, and
 * a stdio one is a process (or three) per session. An Orca worker is a full
 * session that almost never needs a database server, so a batch of workers
 * multiplied them: 17 sessions held about 1.3GB and pushed the host into swap.
 *
 * Orca gives no per-launch way in: `worker-start` and `worktree create` take no
 * extra agent arguments, settings file or environment (only `automations` do).
 * What a session does read at start is the project settings of its working
 * directory, and `deniedMcpServers` in `.claude/settings.local.json` there
 * keeps a named server from starting (checked on 2.1.285: the file written
 * before the launch removes the stdio servers, the same file written after the
 * session started changes nothing). So the exclusion is a file written into
 * the folder just before a worker starts in it, by `bin/worker-mcp-trim.ts`,
 * and the prompts that start workers say to run it first.
 *
 * The names come from `WORKER_MCP_DENY`; empty keeps every server, as before.
 */

/** Env var a turn carries with the excluded server names, comma separated. */
export const WORKER_MCP_DENY_ENV = "BOT_WORKER_MCP_DENY";
/** Env var a turn carries with the path of the helper that writes the exclusion. */
export const WORKER_MCP_TRIM_ENV = "BOT_WORKER_MCP_TRIM";
/** The project settings file a session reads from its working directory, never committed. */
export const WORKER_SETTINGS_PATH = ".claude/settings.local.json";

/**
 * The sentence every prompt that starts an Orca worker carries. The order is the
 * point: the file is read when the session starts, so a worker started first and
 * trimmed after keeps every server.
 */
export const WORKER_MCP_TRIM_RULE = `Before the worker starts, run \`"$${WORKER_MCP_TRIM_ENV}" <folder>\` on the folder it will run in (the one named after \`path:\`; with a new checkout, \`orca worktree create\` it without \`--agent\` first and use the path it prints): it writes the host's MCP exclusions into that folder's \`${WORKER_SETTINGS_PATH}\`, which a session reads only when it starts, so it must come before the launch, never after. It does nothing when the host excludes none. Never start a worker in a new worktree in one step (\`--worktree new-child\`, \`worktree create --agent\`): the agent would be running before the file exists`;

/** Server names from a comma list, trimmed, without blanks or repeats. */
export const parseDenyList = (raw: string | undefined): string[] => [
  ...new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];

/** The environment a turn gets: the names to exclude and the helper that applies them. */
export const workerMcpEnv = (deny: readonly string[], trimScript: string): Record<string, string> => ({
  [WORKER_MCP_DENY_ENV]: deny.join(","),
  [WORKER_MCP_TRIM_ENV]: trimScript,
});

export type MergeResult =
  | { ok: true; text: string; added: string[]; changed: boolean }
  | { ok: false; error: string };

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const nameOf = (entry: unknown): string | undefined => {
  const name = asRecord(entry)?.serverName;
  return typeof name === "string" ? name : undefined;
};

/**
 * `existing` (the text of a settings file, or nothing) with `names` added to its
 * `deniedMcpServers`. Everything else in the file stays as it is, an entry already
 * there (by name or by another shape, e.g. a url) is never duplicated or dropped, and
 * a file that is not a settings object is refused rather than overwritten.
 */
export const mergeDeniedServers = (existing: string | undefined, names: readonly string[]): MergeResult => {
  let settings: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      return { ok: false, error: "the settings file is not valid JSON; fix or remove it by hand" };
    }
    const record = asRecord(parsed);
    if (!record) return { ok: false, error: "the settings file is not a JSON object; fix or remove it by hand" };
    settings = record;
  }
  const current = settings.deniedMcpServers;
  if (current !== undefined && !Array.isArray(current)) {
    return { ok: false, error: "`deniedMcpServers` in the settings file is not a list; fix it by hand" };
  }
  const entries: unknown[] = current ?? [];
  const have = new Set(entries.map(nameOf).filter((n): n is string => n !== undefined));
  const added = names.filter((n) => !have.has(n));
  if (added.length === 0 && existing !== undefined && existing.trim() !== "") {
    return { ok: true, text: existing, added, changed: false };
  }
  const next = { ...settings, deniedMcpServers: [...entries, ...added.map((serverName) => ({ serverName }))] };
  return { ok: true, text: `${JSON.stringify(next, null, 2)}\n`, added, changed: true };
};
