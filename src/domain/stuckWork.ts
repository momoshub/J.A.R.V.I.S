/**
 * Stuck work: Orca tasks nobody is working any more, and PRs on the bot's own
 * repo that went quiet.
 *
 * Both fail silently. A task stays `dispatched` after its worker's terminal
 * died or the worker settled without reporting, and the Run that owns it waits
 * for a `worker_done` that will never come. A PR the bot opened sits with no
 * commit or comment because the turn that was driving it - waiting on a
 * reviewer, on CI, on a fix round - ended or was cut by a restart. Nothing in
 * either case posts anything, so they were found only when someone went
 * looking.
 *
 * The sweeper (application/stuckSweeper.ts) asks every 15 minutes, outside any
 * turn, and DMs the owner what it found, naming the Slack thread that started
 * each one. `mindful` shows the same two lists on demand. Everything here is
 * pure: parsing what `orca` and `gh` print, deciding what is stuck, and what
 * was already said recently.
 */
import { stuckWorkLines } from "./mindful.ts";

/** The Slack thread whose turns started something. */
export type OwnerThread = { readonly channelId: string; readonly threadTs: string };

export type StuckTask = {
  readonly taskId: string;
  readonly runId: string;
  readonly title: string;
  readonly dispatchId?: string;
  /** Why the worker is not live, in a few words. */
  readonly why: string;
  readonly owner?: OwnerThread;
};

export type QuietPr = {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  /** Newest commit, comment or review, or when it was opened. */
  readonly lastActivityAt: number;
  readonly owner?: OwnerThread;
};

export type StuckWork = {
  readonly tasks: readonly StuckTask[];
  readonly prs: readonly QuietPr[];
  /** What could not be checked (Orca down, `gh` failed), so "nothing" is not claimed. */
  readonly problems: readonly string[];
};

export const NO_STUCK_WORK: StuckWork = { tasks: [], prs: [], problems: [] };

/** How often the sweeper looks. */
export const SWEEP_TICK_MS = 15 * 60_000;
/** A PR with no commit, comment or review for this long is quiet. */
export const PR_QUIET_MS = 30 * 60_000;
/**
 * Runs older than this are not looked into: every Run costs an `orca` call per
 * sweep and they pile up by the dozen a day, while a task stuck in one this
 * old has been reported for days already.
 */
export const RUN_WINDOW_MS = 3 * 24 * 60 * 60_000;
/** The same item is not reported again for this long. */
export const REPEAT_AFTER_MS = 4 * 60 * 60_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

const time = (v: unknown): number => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
};

const parseJson = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
};

/**
 * `orca orchestration run-list --json --full`: each run with when it was
 * created (when Orca says), and the next page's cursor. Undefined when it is
 * not that shape.
 */
export const parseRunPage = (
  stdout: string,
): { runs: { id: string; createdAt?: number }[]; next?: string } | undefined => {
  const r = parseJson(stdout);
  if (!isRecord(r) || r.ok !== true || !isRecord(r.result) || !Array.isArray(r.result.runs)) return undefined;
  const runs = r.result.runs.filter(isRecord).flatMap((x) => {
    const id = str(x.id);
    if (!id) return [];
    const created = time(x.created_at);
    return [created ? { id, createdAt: created } : { id }];
  });
  const next = str(r.result.nextCursor);
  return next ? { runs, next } : { runs };
};

export type DispatchedTask = {
  readonly taskId: string;
  readonly title: string;
  readonly dispatchId?: string;
  readonly assignee?: string;
};

/** `orca orchestration task-list --status dispatched --json`: the dispatched tasks, or undefined. */
export const parseDispatchedTasks = (stdout: string): DispatchedTask[] | undefined => {
  const r = parseJson(stdout);
  if (!isRecord(r) || r.ok !== true || !isRecord(r.result) || !Array.isArray(r.result.tasks)) return undefined;
  return r.result.tasks.filter(isRecord).flatMap((t) => {
    const taskId = str(t.id);
    // The filter is asked for, but a row that says otherwise is not ours to report.
    if (!taskId || (t.status !== undefined && t.status !== "dispatched")) return [];
    const dispatchId = str(t.dispatchId);
    const assignee = str(t.assignee);
    return [{ taskId, title: str(t.title) ?? "", ...(dispatchId ? { dispatchId } : {}), ...(assignee ? { assignee } : {}) }];
  });
};

const FINAL_STATES = new Set(["succeeded", "failed", "cancelled", "stopped"]);

/**
 * Why a dispatched task's worker is not live, from `worker-show --json`, or
 * undefined when it is - or might be. Only proof counts: the dispatch is
 * unknown to Orca, its process exited, or it reached a final state without the
 * task moving on. A `settled` stage alone is NOT dead: a worker parked on
 * `orchestration ask` waits for an answer, Orca calls a waiting worker healthy,
 * and `liveness` may be `unverifiable` (identity unproven, a probe that did not
 * answer - after an Orca restart, say) or missing. Only `exited` proves it, and
 * that is caught first. An unanswered or unreadable check is never dead.
 */
export const deadWorkerReason = (workerShowStdout: string): string | undefined => {
  const r = parseJson(workerShowStdout);
  if (!isRecord(r)) return undefined;
  if (r.ok !== true) return isRecord(r.error) && r.error.code === "dispatch_not_found" ? "dispatch not found" : undefined;
  if (!isRecord(r.result)) return undefined;
  const { state, liveness } = r.result;
  if (liveness === "exited") return "worker exited";
  if (typeof state === "string" && FINAL_STATES.has(state)) return `worker ${state}, never reported`;
  return undefined;
};

/**
 * Whether `orca terminal show --json` proves a terminal gone: Orca answered
 * and does not know the handle (stale or not found), or it is orphaned or
 * another terminal. Any other error - a runtime not ready, a timeout, a code
 * added later - is no proof, so the task is not reported.
 */
export const terminalGone = (stdout: string, handle: string): boolean => {
  const r = parseJson(stdout);
  if (!isRecord(r) || typeof r.ok !== "boolean") return false;
  if (!r.ok) return isRecord(r.error) && (r.error.code === "terminal_handle_stale" || r.error.code === "terminal_not_found");
  const t = isRecord(r.result) && isRecord(r.result.terminal) ? r.result.terminal : undefined;
  return !!t && (t.handle !== handle || t.orphaned === true);
};

const newest = (rows: unknown, field: string): number =>
  Array.isArray(rows) ? rows.filter(isRecord).reduce((m, x) => Math.max(m, time(x[field])), 0) : 0;

export type OpenPr = { readonly number: number; readonly title: string; readonly url: string; readonly lastActivityAt: number };

/**
 * `gh pr list --json number,title,url,createdAt,commits,comments,reviews`:
 * each open PR with its newest commit, comment or review. Undefined when it
 * is not that shape.
 */
export const parseOpenPrs = (stdout: string): OpenPr[] | undefined => {
  const r = parseJson(stdout);
  if (!Array.isArray(r)) return undefined;
  return r.filter(isRecord).flatMap((p) => {
    const url = str(p.url);
    if (typeof p.number !== "number" || !url) return [];
    const lastActivityAt = Math.max(
      time(p.createdAt),
      newest(p.commits, "committedDate"),
      newest(p.comments, "createdAt"),
      newest(p.reviews, "submittedAt"),
    );
    return [{ number: p.number, title: str(p.title) ?? "", url, lastActivityAt }];
  });
};

/** The open PRs with nothing new for `quietMs` or longer, quietest first. */
export const quietPrs = (prs: readonly OpenPr[], now: number, quietMs = PR_QUIET_MS): OpenPr[] =>
  prs.filter((p) => now - p.lastActivityAt >= quietMs).sort((a, b) => a.lastActivityAt - b.lastActivityAt);

/** `owner/repo#n`, lowercased, so one PR written two ways is one key. */
export const prRef = (url: string): string => {
  const m = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i);
  return m ? `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() : url.trim().toLowerCase();
};

const bashCommand = (name: unknown, input: unknown): string => {
  if (name !== "Bash" || typeof input !== "string") return "";
  const parsed = parseJson(input);
  return isRecord(parsed) && typeof parsed.command === "string" ? parsed.command : "";
};

const WORKER_START = /\borca\s+orchestration\s+worker-start\b/;
const PR_CREATE = /\bgh\s+pr\s+create\b/;
const DISPATCH_ID = /"dispatchId"\s*:\s*"(ctx_[0-9a-f]{6,})"|\bdispatch(?:Id)?[\s=:]+(ctx_[0-9a-f]{6,})\b/g;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/**
 * What a thread's trace shows it started: the Orca dispatches its
 * `worker-start` calls printed and the PRs its `gh pr create` calls printed.
 * Only for naming an owner in a report - unlike `backgroundLaunches`, which
 * decides what `stop` may end, a loose match here costs a wrong link at worst,
 * so a brief written with `cat > f; orca ... worker-start` in one call still
 * counts. Never throws.
 */
export const traceStarts = (traceText: string): { dispatches: string[]; prs: string[] } => {
  const calls = new Map<string, string>();
  const dispatches = new Set<string>();
  const prs = new Set<string>();
  for (const line of traceText.split("\n")) {
    if (!line.trim()) continue;
    const row = parseJson(line);
    if (!isRecord(row) || typeof row.id !== "string") continue;
    if (row.kind === "call") {
      const command = bashCommand(row.name, row.input);
      if (WORKER_START.test(command) || PR_CREATE.test(command)) calls.set(row.id, command);
      continue;
    }
    const command = row.kind === "result" && typeof row.output === "string" ? calls.get(row.id) : undefined;
    if (!command || typeof row.output !== "string") continue;
    if (WORKER_START.test(command)) {
      for (const m of row.output.matchAll(DISPATCH_ID)) dispatches.add(m[1] ?? m[2] ?? "");
    }
    if (PR_CREATE.test(command)) {
      for (const m of row.output.matchAll(PR_URL)) prs.add(prRef(m[0]));
    }
  }
  dispatches.delete("");
  return { dispatches: [...dispatches], prs: [...prs] };
};

/** The key an item is remembered by, so it is not reported twice in a row. */
export const taskKey = (t: StuckTask): string => `task:${t.taskId}`;
export const prKeyOf = (p: QuietPr): string => `pr:${prRef(p.url)}`;

/** When each item was last reported, from the stored JSON. Anything malformed is forgotten. */
export const parseSeen = (json: string | undefined): Record<string, number> => {
  const r = json ? parseJson(json) : undefined;
  if (!isRecord(r)) return {};
  return Object.fromEntries(Object.entries(r).filter((e): e is [string, number] => typeof e[1] === "number"));
};

/**
 * What to report now - the items not reported in the last `repeatMs` - and
 * the record to keep: those items stamped `now`, and anything older than
 * `repeatMs` dropped so the record does not grow forever.
 */
export const toReport = (
  work: StuckWork,
  seen: Record<string, number>,
  now: number,
  repeatMs = REPEAT_AFTER_MS,
): { fresh: StuckWork; seen: Record<string, number> } => {
  const recent = (key: string): boolean => {
    const at = seen[key];
    return at !== undefined && now - at < repeatMs;
  };
  const tasks = work.tasks.filter((t) => !recent(taskKey(t)));
  const prs = work.prs.filter((p) => !recent(prKeyOf(p)));
  const kept = Object.fromEntries(Object.entries(seen).filter(([, at]) => now - at < repeatMs));
  for (const t of tasks) kept[taskKey(t)] = now;
  for (const p of prs) kept[prKeyOf(p)] = now;
  return { fresh: { tasks, prs, problems: work.problems }, seen: kept };
};

/**
 * The owner's DM: one short message, or undefined when there is nothing new.
 * What could not be checked rides along only next to a real item - on its own
 * it would be a DM every 15 minutes for as long as Orca is closed.
 */
export const stuckDm = (fresh: StuckWork, now: number, prefix: string, team?: string): string | undefined => {
  if (fresh.tasks.length === 0 && fresh.prs.length === 0) return undefined;
  return [
    "🧹 stuck work nobody is moving:",
    ...stuckWorkLines(fresh, now, team),
    "",
    `_\`${prefix} mindful\` shows it all again_`,
  ].join("\n");
};
