/**
 * Read Orca for `sys`: `orca status`, the latest Runs, and each one's tasks.
 *
 * Best-effort and bounded, like the host probe. Every `orca` call is already
 * capped (`createOrcaCli`, 5s); on top of that the whole read has a deadline,
 * so a runtime that answers slowly to every one of twenty task lists still
 * cannot hold `sys` for a minute. Orca not installed, not running, refusing,
 * or too slow all come back as one `unreachable` snapshot, never a throw.
 *
 * There is no "every task" call: `task-list` without `--run` wants a sender
 * terminal, and with one it is scoped to that terminal's Run. So it is
 * `run-list` for the newest `runScan` Runs, then one `task-list --run` each, a
 * few at a time. A Run whose list fails is counted as unread rather than
 * failing the rest.
 */
import type { OrcaRun } from "./orcaTerminal.ts";
import {
  type OrcaSnapshot,
  type OrcaTaskRow,
  parseOrcaStatus,
  parseRunList,
  parseTaskList,
} from "../../domain/orcaStatus.ts";

export const ORCA_RUN_SCAN = 20;
export const ORCA_PROBE_DEADLINE_MS = 8_000;
const CONCURRENCY = 5;

export type OrcaProbe = { readonly read: () => Promise<OrcaSnapshot> };

export type OrcaProbeOptions = {
  readonly run: OrcaRun;
  /** Newest Runs whose tasks are read. */
  readonly runScan?: number;
  readonly deadlineMs?: number;
};

const unreachable = (reason: string): OrcaSnapshot => ({ kind: "unreachable", reason });

const gather = async (opts: OrcaProbeOptions, late: () => boolean): Promise<OrcaSnapshot> => {
  const status = await opts.run(["status", "--json"]);
  // -1 is "no orca on PATH" from createOrcaCli.
  if (status.code === -1) return unreachable("orca CLI not found");
  const runtime = parseOrcaStatus(status.stdout);
  if (!runtime) return unreachable(status.code === 0 ? "unexpected status output" : `orca status exited ${status.code}`);
  if (!runtime.reachable) return unreachable(`runtime ${runtime.state}`);

  const listed = await opts.run(["orchestration", "run-list", "--json", "--full", "--limit", String(opts.runScan ?? ORCA_RUN_SCAN)]);
  const runList = parseRunList(listed.stdout);
  if (!runList) return unreachable("run-list failed");

  const tasks: OrcaTaskRow[] = [];
  let unreadRuns = 0;
  const queue = [...runList.runs];
  const worker = async () => {
    // Past the deadline nobody is waiting: start no more calls.
    for (let r = queue.shift(); r && !late(); r = queue.shift()) {
      const out = await opts.run(["orchestration", "task-list", "--run", r.id, "--json", "--full", "--brief"]);
      const rows = parseTaskList(out.stdout, r.id);
      if (rows) tasks.push(...rows);
      else unreadRuns += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return { kind: "ok", runtime, runs: runList.runs, tasks, unreadRuns, moreRuns: runList.more };
};

export const createOrcaProbe = (opts: OrcaProbeOptions): OrcaProbe => ({
  read: async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let late = false;
    const deadline = new Promise<OrcaSnapshot>((resolve) => {
      timer = setTimeout(() => {
        late = true;
        resolve(unreachable("timed out"));
      }, opts.deadlineMs ?? ORCA_PROBE_DEADLINE_MS);
    });
    try {
      return await Promise.race([gather(opts, () => late).catch(() => unreachable("probe failed")), deadline]);
    } finally {
      clearTimeout(timer);
    }
  },
});
