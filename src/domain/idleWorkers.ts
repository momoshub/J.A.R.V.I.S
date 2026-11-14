/**
 * Which Orca worker sessions are safe to close because nobody will use them
 * again: the interactive agent sits at its prompt (~250MB plus its MCP child
 * processes) long after its task ended.
 *
 * Pure: the reaper (`application/idleReaper.ts`) hands over the raw `--json`
 * stdout of `orca orchestration worker-list --full` and `orca terminal list`,
 * and everything here parses and decides. Stdout that is not the expected JSON
 * parses to undefined, never a throw, and a field Orca does not send makes the
 * session SKIPPED rather than guessed: closing a session that was in use costs
 * far more than leaving an idle one for the next sweep.
 *
 * Only supervised workers are ever candidates (a row of `worker-list`), so a
 * user's own agent session, even one in an Orca pane, and the bot's own
 * `claude -p` turns can never be selected.
 */

export const DEFAULT_REAP_IDLE_MS = 3 * 60 * 60_000;
export const DEFAULT_REAP_INTERVAL_MS = 30 * 60_000;

export type WorkerRow = {
  readonly dispatchId: string;
  readonly taskId?: string;
  readonly runId?: string;
  /** `succeeded`, `failed`, `ready`... Orca's worker state. */
  readonly state: string;
  readonly handle: string;
  /** `active`, `reclaimable`, `retained`, `released`... Orca's terminal accounting. */
  readonly terminalState: string;
  /** A person asked Orca to keep this terminal open. */
  readonly keptOpen: boolean;
  /** Orca schedules its own release; it will close the session without us. */
  readonly autoReleaseAt?: number;
  /** Orca flagged the worker as needing a human (a prompt, a decision). */
  readonly needsAttention: boolean;
  /** `live`, `exited`, `unverifiable`... */
  readonly liveness: string;
};

export type TerminalRow = {
  readonly handle: string;
  readonly lastOutputAt?: number;
  readonly orphaned: boolean;
};

export type Candidate = {
  readonly worker: WorkerRow;
  readonly terminal?: TerminalRow;
  /** The task's status (`completed`, `failed`, `blocked`, `dispatched`...); undefined when no task or unreadable. */
  readonly taskStatus?: string;
  /** Pending decision gates on the task; undefined when they could not be read. */
  readonly pendingGates?: number;
};

export type ReapContext = {
  readonly now: number;
  readonly idleMs: number;
  /** Dispatch ids a waiting watch is on. */
  readonly watched: ReadonlySet<string>;
  /** Dispatch ids with a question put to a thread and not yet answered. */
  readonly asking: ReadonlySet<string>;
};

export type Verdict =
  | { readonly reap: true; readonly why: string; readonly settled: boolean; readonly idleMs: number }
  | { readonly reap: false; readonly why: string };

const record = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

const resultOf = (stdout: string): Record<string, unknown> | undefined => {
  try {
    const top = record(JSON.parse(stdout));
    return top?.ok === true ? record(top.result) : undefined;
  } catch {
    return undefined;
  }
};

/** Task statuses that mean the work is over. */
const FINISHED_TASK = new Set(["completed", "failed", "cancelled", "canceled"]);
/** Worker states that mean the agent reported or was stopped. */
const SETTLED_WORKER = new Set(["succeeded", "failed"]);

/** `orca orchestration worker-list --json --full`: the rows plus the cursor of the next page. */
export const parseWorkerList = (stdout: string): { workers: WorkerRow[]; next?: string } | undefined => {
  const r = resultOf(stdout);
  if (!r || !Array.isArray(r.workers)) return undefined;
  const workers = r.workers.flatMap((x): WorkerRow[] => {
    const w = record(x);
    const dispatchId = str(w?.dispatchId);
    const handle = str(w?.agentTerminalHandle) ?? str(w?.terminal);
    if (!w || !dispatchId || !handle) return [];
    const resource = record(w.resource);
    const projection = record(w.projection);
    const attention = record(projection?.attention);
    const auto = str(resource?.autoReleaseAt) ? Date.parse(String(resource?.autoReleaseAt)) : undefined;
    const taskId = str(w.taskId);
    const runId = str(w.runId) ?? str(projection?.runId);
    return [
      {
        dispatchId,
        ...(taskId ? { taskId } : {}),
        ...(runId ? { runId } : {}),
        state: str(w.workerState) ?? str(w.state) ?? "unknown",
        handle,
        terminalState: str(w.terminalState) ?? "unknown",
        keptOpen: str(resource?.retainedReason) !== undefined || str(w.terminalState) === "retained",
        ...(auto !== undefined && Number.isFinite(auto) ? { autoReleaseAt: auto } : {}),
        // Unknown attention is treated as "needs it": the safe side.
        needsAttention: attention === undefined || attention.requiresAction !== false,
        liveness: str(record(projection?.liveness)?.verdict) ?? str(w.liveness) ?? "unknown",
      },
    ];
  });
  const page = record(r.page);
  return { workers, ...(page?.hasMore === true && str(page.nextCursor) ? { next: str(page.nextCursor) } : {}) };
};

/** `orca terminal list --json`. */
export const parseTerminalList = (stdout: string): TerminalRow[] | undefined => {
  const r = resultOf(stdout);
  if (!r || !Array.isArray(r.terminals)) return undefined;
  return r.terminals.flatMap((x): TerminalRow[] => {
    const t = record(x);
    const handle = str(t?.handle);
    if (!t || !handle) return [];
    return [
      { handle, orphaned: t.orphaned === true, ...(typeof t.lastOutputAt === "number" ? { lastOutputAt: t.lastOutputAt } : {}) },
    ];
  });
};

/** The `ctx_...` dispatch ids inside text, e.g. a watch's shell check. */
export const dispatchIdsIn = (text: string): string[] => text.match(/ctx_[A-Za-z0-9_-]+/g) ?? [];

/** Pending gates in `orca orchestration gate-list --json`; undefined when unreadable. */
export const countGates = (stdout: string): number | undefined => {
  const r = resultOf(stdout);
  return r && Array.isArray(r.gates) ? r.gates.length : undefined;
};

/** Does this worker need its task's status looked up before it can be judged? */
export const needsTaskLookup = (w: WorkerRow): boolean => w.taskId !== undefined && w.runId !== undefined;

/** Whether the session is idle past the threshold and nothing needs it. Order is the safety order. */
export const judge = (c: Candidate, ctx: ReapContext): Verdict => {
  const w = c.worker;
  const skip = (why: string): Verdict => ({ reap: false, why });
  if (w.terminalState === "released" || w.liveness === "exited") return skip("already closed");
  if (w.liveness !== "live") return skip(`liveness ${w.liveness} not proven`);
  if (w.keptOpen) return skip("kept open on purpose");
  if (w.autoReleaseAt !== undefined && w.autoReleaseAt > ctx.now) return skip("Orca is about to release it");
  if (ctx.watched.has(w.dispatchId)) return skip("a watch is on it");
  if (ctx.asking.has(w.dispatchId)) return skip("a question is waiting for an answer");
  if (w.needsAttention) return skip("Orca says it needs attention");
  if (!c.terminal || c.terminal.handle !== w.handle || c.terminal.orphaned) return skip("terminal not live in Orca");
  if (c.terminal.lastOutputAt === undefined) return skip("no output time");
  const idleMs = ctx.now - c.terminal.lastOutputAt;
  if (idleMs < ctx.idleMs) return skip("not idle long enough");

  const settled = SETTLED_WORKER.has(w.state);
  if (w.taskId === undefined) return { reap: true, why: "not tied to a task", settled, idleMs };
  const status = c.taskStatus;
  if (status !== undefined && FINISHED_TASK.has(status)) return { reap: true, why: `task ${status}`, settled, idleMs };
  if (status === "blocked") {
    if (c.pendingGates === undefined) return skip("pending gates unreadable");
    return c.pendingGates === 0
      ? { reap: true, why: "task blocked with nothing pending", settled, idleMs }
      : skip("task blocked on a pending gate");
  }
  // A reported worker whose task could not be read still has nothing left to do.
  if (status === undefined && settled) return { reap: true, why: `worker ${w.state}`, settled, idleMs };
  return skip(status === undefined ? "task status unreadable" : `task still ${status}`);
};

export type Selection = { readonly dispatchId: string; readonly handle: string; readonly verdict: Extract<Verdict, { reap: true }> };

/** Every candidate that is eligible, longest idle first. */
export const selectIdle = (candidates: readonly Candidate[], ctx: ReapContext): Selection[] =>
  candidates
    .flatMap((c): Selection[] => {
      const verdict = judge(c, ctx);
      return verdict.reap ? [{ dispatchId: c.worker.dispatchId, handle: c.worker.handle, verdict }] : [];
    })
    .sort((a, b) => b.verdict.idleMs - a.verdict.idleMs);
