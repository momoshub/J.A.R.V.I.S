/**
 * Finds stuck work on the host (see domain/stuckWork.ts): dispatched Orca
 * tasks whose worker is gone, and quiet open PRs on the bot's own repo, each
 * with the Slack thread whose trace started it.
 *
 * Read-only: `orca orchestration run-list` / `task-list` / `worker-show`,
 * `orca terminal show` for a task dispatched without a worker, `gh pr list` in
 * the repo folder, and the per-thread tool traces. Needs no sender terminal -
 * those reads work outside any Orca pane. The one write: a task whose worker
 * succeeded and whose thread already holds the bot's own post after the worker
 * ended was finished, only never marked, so it is set `completed` (`task-update`)
 * instead of being reported. Anything short of both proofs stays reported. Never throws: whatever could not be
 * checked comes back in `problems`, never as "nothing stuck".
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AUTO_CLOSE_RESULT,
  deadWorkerReason,
  parseDispatchedTasks,
  parseOpenPrs,
  parseRunPage,
  prRef,
  quietPrs,
  reportedAfter,
  RUN_WINDOW_MS,
  terminalGone,
  traceStarts,
  workerEndedAt,
  workerSucceeded,
  type OwnerThread,
  type ThreadPost,
  type StuckTask,
  type StuckWork,
} from "../../domain/stuckWork.ts";
import type { CommandRunner } from "../llm/backgroundAgents.ts";
import { readThreadTrace } from "../llm/toolTraceLog.ts";
import type { OrcaRun } from "./orcaTerminal.ts";

export type StuckWorkProbe = { scan: () => Promise<StuckWork> };

/** Runs (newest first) read per page, and pages at most, inside `RUN_WINDOW_MS`. */
const RUN_PAGE = 50;
const MAX_RUN_PAGES = 4;
/** Open PRs read; more than ~25 with their commits trips GitHub's GraphQL node limit. */
const PR_LIMIT = 25;
/** Only traces touched this recently are searched for owners. */
export const OWNER_TRACE_WINDOW_MS = 7 * 24 * 60 * 60_000;
const OWNER_TRACE_BYTES = 16 * 1024 * 1024;
/** Each `orca` call is a ~0.5s node start, so a sweep runs several at once. */
const CONCURRENCY = 8;

const mapLimited = async <T, R>(items: readonly T[], limit: number, f: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(f))));
  return out;
};

export type StuckWorkProbeConfig = {
  orca: OrcaRun;
  /** `gh` with the bot's own repo folder as its cwd. */
  gh: CommandRunner;
  /** `<LOG_DIR>/threads`. */
  traceDir: string;
  now: () => number;
  quietMs?: number;
  /** PR -> thread records written when the bot opened the PR (`stuck_pr_threads`); wins over the trace match. */
  recordedOwners?: () => ReadonlyMap<string, OwnerThread>;
  /** A thread's messages (read-only); throws when Slack will not say. Without it nothing is auto-closed. */
  readThread?: (owner: OwnerThread) => Promise<readonly ThreadPost[]>;
};

/** What one trace started, remembered until the file changes. */
export type TraceCache = Map<string, { mtime: number; size: number; started: { dispatches: string[]; created: string[]; prs: string[] } }>;

/**
 * Which thread started each dispatch and each PR, newest trace winning. The
 * reads are synchronous on the bot's loop (~0.4s cold over 27MB of traces
 * here), so with a `cache` a trace is parsed again only when its mtime or size
 * moved - a later sweep reads just the threads that ran since.
 */
export const findOwners = (
  traceDir: string,
  since: number,
  cache?: TraceCache,
): { dispatches: Map<string, OwnerThread>; sure: Map<string, OwnerThread>; prs: Map<string, OwnerThread> } => {
  const dispatches = new Map<string, OwnerThread>();
  // Dispatch -> thread for the auto-close only: created by a `worker-start` in exactly one thread, named by no other.
  const created = new Map<string, OwnerThread[]>();
  const mentioned = new Map<string, number>();
  const prs = new Map<string, OwnerThread>();
  const files: { channelId: string; threadTs: string; mtime: number; size: number }[] = [];
  let channels: string[] = [];
  try {
    channels = readdirSync(traceDir);
  } catch {
    return { dispatches, sure: new Map(), prs };
  }
  for (const channelId of channels) {
    if (channelId === "_none") continue;
    let names: string[] = [];
    try {
      names = readdirSync(join(traceDir, channelId));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      try {
        const { mtimeMs: mtime, size } = statSync(join(traceDir, channelId, name));
        if (mtime >= since) files.push({ channelId, threadTs: name.slice(0, -".jsonl".length), mtime, size });
      } catch {
        // gone between the listing and the stat
      }
    }
  }
  files.sort((a, b) => a.mtime - b.mtime);
  for (const f of files) {
    const owner = { channelId: f.channelId, threadTs: f.threadTs };
    const key = `${f.channelId}/${f.threadTs}`;
    const hit = cache?.get(key);
    const started =
      hit && hit.mtime === f.mtime && hit.size === f.size
        ? hit.started
        : traceStarts(readThreadTrace(traceDir, f.channelId, f.threadTs, OWNER_TRACE_BYTES));
    cache?.set(key, { mtime: f.mtime, size: f.size, started });
    for (const d of started.dispatches) {
      dispatches.set(d, owner);
      mentioned.set(d, (mentioned.get(d) ?? 0) + 1);
    }
    for (const d of started.created) created.set(d, [...(created.get(d) ?? []), owner]);
    for (const p of started.prs) prs.set(p, owner);
  }
  // A trace gone or out of the window is not remembered either.
  const live = new Set(files.map((f) => `${f.channelId}/${f.threadTs}`));
  for (const key of cache?.keys() ?? []) if (!live.has(key)) cache?.delete(key);
  const sure = new Map<string, OwnerThread>();
  for (const [d, owned] of created) if (owned.length === 1 && mentioned.get(d) === 1) sure.set(d, owned[0]!);
  return { dispatches, sure, prs };
};

export const createStuckWorkProbe = (config: StuckWorkProbeConfig): StuckWorkProbe => {
  const orcaJson = (args: readonly string[]) => config.orca(["orchestration", ...args, "--json"]);
  const traces: TraceCache = new Map();

  const runIds = async (): Promise<string[] | undefined> => {
    const since = config.now() - RUN_WINDOW_MS;
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_RUN_PAGES; page++) {
      const out = await config.orca([
        "orchestration", "run-list", "--limit", String(RUN_PAGE), ...(cursor ? ["--cursor", cursor] : []), "--json", "--full",
      ]);
      const parsed = parseRunPage(out.stdout);
      if (!parsed) return page === 0 ? undefined : ids;
      // Newest first: a run with no date is kept, the first old one ends the walk.
      const recent = parsed.runs.filter((r) => (r.createdAt ?? since) >= since);
      ids.push(...recent.map((r) => r.id));
      cursor = parsed.next;
      if (!cursor || recent.length < parsed.runs.length) break;
    }
    return ids;
  };

  const fullWorkerShow = (dispatchId: string) => orcaJson(["worker-show", "--dispatch", dispatchId, "--full"]);

  /**
   * Whether this task's thread has the bot's own post after the worker ended and
   * Orca took the close. Any doubt - no owner thread, Slack unreadable, a
   * `task-update` that did not answer ok - is false, so the task is reported.
   */
  const autoClosed = async (t: { taskId: string; runId: string; endedAt?: number }, owner: OwnerThread | undefined): Promise<boolean> => {
    if (!t.endedAt || !owner || !config.readThread) return false;
    try {
      if (!reportedAfter(await config.readThread(owner), t.endedAt)) return false;
      const out = await orcaJson(["task-update", "--id", t.taskId, "--run", t.runId, "--status", "completed", "--result", AUTO_CLOSE_RESULT]);
      return (JSON.parse(out.stdout) as { ok?: unknown } | null)?.ok === true;
    } catch {
      return false;
    }
  };

  const stuckTasks = async (problems: string[]): Promise<(Omit<StuckTask, "owner"> & { endedAt?: number })[]> => {
    const runs = await runIds();
    if (!runs) {
      problems.push("Orca (not running, or `run-list` failed)");
      return [];
    }
    const perRun = await mapLimited(runs, CONCURRENCY, async (runId) => {
      const out = await orcaJson(["task-list", "--run", runId, "--status", "dispatched"]);
      return { runId, tasks: parseDispatchedTasks(out.stdout) };
    });
    if (perRun.some((r) => !r.tasks)) problems.push("some Orca Runs (`task-list` failed)");
    const dispatched = perRun.flatMap((r) => (r.tasks ?? []).map((t) => ({ ...t, runId: r.runId })));
    const checked = await mapLimited(dispatched, CONCURRENCY, async (t) => {
      if (t.dispatchId) {
        // `worker-show` exits 1 on `dispatch_not_found` but still prints JSON.
        const shown = (await orcaJson(["worker-show", "--dispatch", t.dispatchId])).stdout;
        const why = deadWorkerReason(shown);
        if (!why) return undefined;
        // The concise view has no times: ask for the full record only for a success.
        const endedAt = config.readThread && workerSucceeded(shown)
          ? workerEndedAt((await fullWorkerShow(t.dispatchId)).stdout)
          : undefined;
        return { ...t, why, ...(endedAt ? { endedAt } : {}) };
      }
      if (!t.assignee) return undefined;
      const shown = await config.orca(["terminal", "show", "--terminal", t.assignee, "--json"]);
      return terminalGone(shown.stdout, t.assignee) ? { ...t, why: "its terminal is gone" } : undefined;
    });
    return checked
      .filter((t): t is NonNullable<typeof t> => t !== undefined)
      .map((t) => ({
        taskId: t.taskId,
        runId: t.runId,
        title: t.title,
        why: t.why,
        ...(t.dispatchId ? { dispatchId: t.dispatchId } : {}),
        ...(t.endedAt ? { endedAt: t.endedAt } : {}),
      }));
  };

  const quiet = async (problems: string[]) => {
    const out = await config.gh([
      // Least recently updated first: past the limit it is the busy ones that drop.
      "gh", "pr", "list", "--state", "open", "--search", "sort:updated-asc", "--limit", String(PR_LIMIT),
      "--json", "number,title,url,createdAt,commits,comments,reviews,author,isDraft,reviewDecision,statusCheckRollup",
    ]);
    const prs = out.code === 0 ? parseOpenPrs(out.stdout) : undefined;
    if (!prs) {
      problems.push(`open PRs (\`gh pr list\` failed: ${(out.stderr.trim() || `exit ${out.code}`).split("\n")[0]?.slice(0, 80)})`);
      return [];
    }
    if (prs.length >= PR_LIMIT) problems.push(`open PRs past the ${PR_LIMIT} least recently updated`);
    return quietPrs(prs, config.now(), config.quietMs);
  };

  return {
    scan: async () => {
      try {
        const problems: string[] = [];
        const [found, prs] = await Promise.all([stuckTasks(problems), quiet(problems)]);
        if (found.length === 0 && prs.length === 0) return { tasks: [], prs: [], problems };
        const owners = findOwners(config.traceDir, config.now() - OWNER_TRACE_WINDOW_MS, traces);
        const recorded = config.recordedOwners?.();
        const withOwner = <T>(item: T, owner: OwnerThread | undefined): T => (owner ? { ...item, owner } : item);
        const ownerOf = (t: { dispatchId?: string }) => (t.dispatchId ? owners.dispatches.get(t.dispatchId) : undefined);
        // A write needs the unambiguous owner; the loose one only names a thread in the report.
        const sureOf = (t: { dispatchId?: string }) => (t.dispatchId ? owners.sure.get(t.dispatchId) : undefined);
        const closed = await mapLimited(found, CONCURRENCY, (t) => autoClosed(t, sureOf(t)));
        const tasks = found.filter((_, i) => !closed[i]).map(({ endedAt: _endedAt, ...t }) => t);
        const autoClosedCount = closed.filter(Boolean).length;
        return {
          ...(autoClosedCount > 0 ? { autoClosed: autoClosedCount } : {}),
          tasks: tasks.map((t) => withOwner(t, ownerOf(t))),
          prs: prs.map((p) => withOwner(p, recorded?.get(prRef(p.url)) ?? owners.prs.get(prRef(p.url)))),
          problems,
        };
      } catch (e) {
        return { tasks: [], prs: [], problems: [`the sweep itself (${e instanceof Error ? e.message : String(e)})`] };
      }
    },
  };
};
