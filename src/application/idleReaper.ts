/**
 * The idle-worker reaper: every `ORCA_REAP_INTERVAL_MS`, outside any turn, it
 * closes Orca worker sessions that nobody will use again (see
 * domain/idleWorkers.ts for the rules).
 *
 * An interactive worker keeps its agent process and MCP children alive until
 * its terminal closes, and Orca only auto-releases one that reported
 * `worker_done`. A worker that ended its turn without reporting, or whose
 * release was never run, sat there for days at ~250MB each.
 *
 * Closing goes through Orca, never a pid: `worker-release` for a settled
 * worker (it archives the output first), `worker-stop` for one that never
 * settled. Both fence the dispatch and close exactly that worker's terminal,
 * helpers included. There is deliberately no kill fallback: a process cannot be
 * tied back to a worker with certainty, and a wrong kill takes someone's
 * session. A failed close is logged and retried on the next sweep.
 *
 * No model, no turn. Read-only until a session has been judged eligible, and
 * `dryRun` stops there and only logs what it would close.
 */
import {
  type Candidate,
  countGates,
  orcaIdsIn,
  needsTaskLookup,
  parseTerminalList,
  parseWorkerList,
  selectIdle,
  type TerminalRow,
  type WorkerRow,
} from "../domain/idleWorkers.ts";
import { parseTaskList } from "../domain/orcaStatus.ts";
import type { Clock } from "./ports.ts";

/** One `orca` call: exit code and stdout. Never throws. */
export type ReapOrcaCall = (args: readonly string[]) => Promise<{ code: number; stdout: string }>;

export type IdleReaperDeps = {
  readonly clock: Clock;
  readonly orca: ReapOrcaCall;
  /** Shell checks of the watches still waiting; a dispatch id inside one means a live watch. */
  readonly watchChecks: () => readonly string[];
  /** Dispatch ids with a worker question not yet answered. */
  readonly askingDispatches: () => readonly string[];
  readonly idleMs: number;
  readonly dryRun?: boolean;
  readonly log?: (msg: string) => void;
};

export type IdleReaper = {
  /** One sweep; returns the dispatches closed (or, in a dry run, that would be). Never throws, never overlaps itself. */
  tick: () => Promise<string[]>;
};

const PAGE = 100;
const MAX_PAGES = 5;
const TERMINAL_LIMIT = 1000;

export const createIdleReaper = (deps: IdleReaperDeps): IdleReaper => {
  let running = false;

  const workers = async (): Promise<WorkerRow[] | undefined> => {
    const all: WorkerRow[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const out = await deps.orca([
        "orchestration", "worker-list", "--json", "--full", "--limit", String(PAGE), ...(cursor ? ["--cursor", cursor] : []),
      ]);
      const parsed = parseWorkerList(out.stdout);
      if (!parsed) return page === 0 ? undefined : all;
      all.push(...parsed.workers);
      cursor = parsed.next;
      if (!cursor) break;
    }
    return all;
  };

  const once = async (): Promise<string[]> => {
    const rows = await workers();
    if (!rows) return [];
    // Every row not released, whatever its liveness: a row that shares a
    // terminal with another one makes both unsafe to close.
    const open = rows.filter((w) => w.terminalState !== "released");
    if (open.length === 0) return [];
    const terminals = parseTerminalList((await deps.orca(["terminal", "list", "--json", "--limit", String(TERMINAL_LIMIT)])).stdout);
    // Unreadable terminal list: nothing can be proven idle.
    if (!terminals) return [];
    const byHandle = new Map<string, TerminalRow>(terminals.map((t) => [t.handle, t]));
    const now = deps.clock();
    // Only sessions already idle past the threshold are worth a task lookup.
    const idle = open.filter((w) => w.liveness === "live").filter((w) => {
      const t = byHandle.get(w.handle);
      return t?.lastOutputAt !== undefined && now - t.lastOutputAt >= deps.idleMs;
    });
    if (idle.length === 0) return [];

    const statuses = new Map<string, string>();
    for (const runId of new Set(idle.filter(needsTaskLookup).map((w) => w.runId as string))) {
      const tasks = parseTaskList((await deps.orca(["orchestration", "task-list", "--run", runId, "--json", "--brief"])).stdout, runId);
      for (const t of tasks ?? []) statuses.set(t.id, t.status);
    }
    const gates = new Map<string, number | undefined>();
    for (const w of idle) {
      if (!w.taskId || !w.runId || statuses.get(w.taskId) !== "blocked") continue;
      const out = await deps.orca(["orchestration", "gate-list", "--run", w.runId, "--task", w.taskId, "--status", "pending", "--json"]);
      gates.set(w.dispatchId, countGates(out.stdout));
    }
    const handleUse = new Map<string, number>();
    for (const w of open) handleUse.set(w.handle, (handleUse.get(w.handle) ?? 0) + 1);
    const candidates: Candidate[] = idle.map((worker) => ({
      worker,
      ...((handleUse.get(worker.handle) ?? 0) > 1 ? { sharedHandle: true } : {}),
      ...(byHandle.has(worker.handle) ? { terminal: byHandle.get(worker.handle) } : {}),
      ...(worker.taskId && statuses.has(worker.taskId) ? { taskStatus: statuses.get(worker.taskId) } : {}),
      ...(gates.has(worker.dispatchId) ? { pendingGates: gates.get(worker.dispatchId) } : {}),
    }));

    const picked = selectIdle(candidates, {
      now,
      idleMs: deps.idleMs,
      watched: new Set(deps.watchChecks().flatMap(orcaIdsIn)),
      asking: new Set(deps.askingDispatches()),
    });
    const closed: string[] = [];
    for (const s of picked) {
      const mins = Math.round(s.verdict.idleMs / 60_000);
      const label = `${s.dispatchId} (${s.handle}, idle ${mins} min, ${s.verdict.why})`;
      if (deps.dryRun) {
        deps.log?.(`would close ${label}`);
        closed.push(s.dispatchId);
        continue;
      }
      const verb = s.verdict.settled ? "worker-release" : "worker-stop";
      const out = await deps.orca(["orchestration", verb, "--dispatch", s.dispatchId, "--json"]);
      if (out.code === 0) {
        deps.log?.(`closed ${label} via ${verb}`);
        closed.push(s.dispatchId);
      } else {
        deps.log?.(`could not close ${label}: ${verb} exited ${out.code}; will retry next sweep`);
      }
    }
    return closed;
  };

  return {
    tick: async () => {
      if (running) return [];
      running = true;
      try {
        return await once();
      } catch (e) {
        deps.log?.(`sweep failed: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      } finally {
        running = false;
      }
    },
  };
};
