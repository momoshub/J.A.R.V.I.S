import { describe, expect, test } from "bun:test";
import { createIdleReaper, type ReapOrcaCall } from "../../src/application/idleReaper.ts";

const NOW = 1_000_000_000_000;
const HOUR = 3_600_000;
const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, result }) });

type W = { id: string; task?: string; run?: string; state?: string; term: string; attention?: boolean; retained?: boolean; owner?: string };
const workerRow = (w: W) => ({
  dispatchId: w.id,
  ...(w.task ? { taskId: w.task, runId: w.run ?? "run_1" } : {}),
  workerState: w.state ?? "ready",
  agentTerminalHandle: w.term,
  terminalState: w.retained ? "retained" : "active",
  resource: { retainedReason: w.retained ? "kept" : null, ownerDispatchId: w.owner ?? w.id },
  projection: { attention: { categories: [], requiresAction: w.attention ?? false }, liveness: { verdict: "live" } },
});

const harness = (opts: {
  workers: W[];
  idleHours: Record<string, number>;
  tasks?: Record<string, string>;
  gates?: Record<string, number>;
  watches?: string[];
  asking?: string[];
  failStop?: boolean;
  dryRun?: boolean;
}) => {
  const calls: string[][] = [];
  const logs: string[] = [];
  const orca: ReapOrcaCall = async (args) => {
    calls.push([...args]);
    const [a, b] = args;
    if (b === "worker-list") return ok({ workers: opts.workers.map(workerRow), page: { hasMore: false } });
    if (a === "terminal" && b === "list")
      return ok({ terminals: opts.workers.map((w) => ({ handle: w.term, orphaned: false, lastOutputAt: NOW - (opts.idleHours[w.id] ?? 0) * HOUR })) });
    if (b === "task-list")
      return ok({ tasks: Object.entries(opts.tasks ?? {}).map(([id, status]) => ({ id, run_id: "run_1", status, task_title: id })) });
    if (b === "gate-list") return ok({ gates: Array.from({ length: opts.gates?.[args[args.indexOf("--task") + 1] ?? ""] ?? 0 }, () => ({})) });
    if (b === "worker-release" || b === "worker-stop") return { code: opts.failStop ? 1 : 0, stdout: "{}" };
    return { code: 1, stdout: "" };
  };
  const reaper = createIdleReaper({
    clock: () => NOW,
    orca,
    watchChecks: () => opts.watches ?? [],
    askingDispatches: () => opts.asking ?? [],
    idleMs: 3 * HOUR,
    dryRun: opts.dryRun,
    log: (m) => logs.push(m),
  });
  const closers = () => calls.filter((c) => c[1] === "worker-release" || c[1] === "worker-stop");
  return { reaper, calls, logs, closers };
};

describe("idle reaper", () => {
  test("closes only eligible sessions, release for a settled worker and stop for the rest", async () => {
    const h = harness({
      workers: [
        { id: "ctx_done", task: "t_done", state: "succeeded", term: "term_1" },
        { id: "ctx_failed_task", task: "t_failed", term: "term_2" },
        { id: "ctx_running", task: "t_run", term: "term_3" },
        { id: "ctx_fresh", task: "t_fresh", term: "term_4" },
        { id: "ctx_watched", task: "t_w", term: "term_5" },
        { id: "ctx_asking", task: "t_a", term: "term_6" },
        { id: "ctx_notask", term: "term_7" },
        { id: "ctx_kept", task: "t_k", term: "term_8", retained: true },
        { id: "ctx_attn", task: "t_attn", term: "term_9", attention: true },
      ],
      idleHours: { ctx_done: 10, ctx_failed_task: 20, ctx_running: 50, ctx_fresh: 1, ctx_watched: 9, ctx_asking: 9, ctx_notask: 6, ctx_kept: 9, ctx_attn: 9 },
      tasks: { t_done: "completed", t_failed: "failed", t_run: "dispatched", t_fresh: "completed", t_w: "completed", t_a: "completed", t_k: "completed", t_attn: "completed" },
      watches: ["bun bin/orca-worker-wait.ts ctx_watched --past-wait"],
      asking: ["ctx_asking"],
    });
    const closed = await h.reaper.tick();
    expect(closed).toEqual(["ctx_failed_task", "ctx_done", "ctx_notask"]);
    expect(h.closers().map((c) => [c[1], c[3]])).toEqual([
      ["worker-stop", "ctx_failed_task"],
      ["worker-release", "ctx_done"],
      ["worker-stop", "ctx_notask"],
    ]);
    expect(h.logs).toHaveLength(3);
    expect(h.logs[0]).toContain("closed ctx_failed_task (term_2, idle 1200 min, task failed) via worker-stop");
  });

  test("a blocked task is closed only when no gate is pending", async () => {
    const h = harness({
      workers: [
        { id: "ctx_free", task: "t_free", state: "stopped", term: "term_1" },
        { id: "ctx_gated", task: "t_gated", state: "stopped", term: "term_2" },
      ],
      idleHours: { ctx_free: 5, ctx_gated: 5 },
      tasks: { t_free: "blocked", t_gated: "blocked" },
      gates: { t_gated: 1 },
    });
    expect(await h.reaper.tick()).toEqual(["ctx_free"]);
  });

  test("a blocked task whose worker is still going (an ask) is left alone, a stopped one is closed", async () => {
    const h = harness({
      workers: [
        { id: "ctx_asking", task: "t_ask", state: "ready", term: "term_1" },
        { id: "ctx_stopped", task: "t_stop", state: "stopped", term: "term_2" },
      ],
      idleHours: { ctx_asking: 40, ctx_stopped: 40 },
      tasks: { t_ask: "blocked", t_stop: "blocked" },
    });
    expect(await h.reaper.tick()).toEqual(["ctx_stopped"]);
    expect(h.closers().map((c) => [c[1], c[3]])).toEqual([["worker-stop", "ctx_stopped"]]);
  });

  test("a watch on the Run protects every worker in it", async () => {
    const h = harness({
      workers: [{ id: "ctx_a", task: "t", term: "term_1" }],
      idleHours: { ctx_a: 9 },
      tasks: { t: "completed" },
      watches: ["orca orchestration task-list --run run_1 --json | jq -re '...'"],
    });
    expect(await h.reaper.tick()).toEqual([]);
    expect(h.closers()).toEqual([]);
  });

  test("a terminal reused by a newer dispatch is not closed through the old one", async () => {
    const h = harness({
      workers: [
        { id: "ctx_old", task: "t_old", state: "succeeded", term: "term_1", owner: "ctx_new" },
        { id: "ctx_new", task: "t_new", state: "ready", term: "term_1" },
        { id: "ctx_twin_a", task: "t_a", term: "term_2" },
        { id: "ctx_twin_b", task: "t_b", term: "term_2" },
      ],
      idleHours: { ctx_old: 30, ctx_new: 30, ctx_twin_a: 30, ctx_twin_b: 30 },
      tasks: { t_old: "completed", t_new: "completed", t_a: "completed", t_b: "completed" },
    });
    expect(await h.reaper.tick()).toEqual([]);
  });

  test("dry run closes nothing and says what it would", async () => {
    const h = harness({ workers: [{ id: "ctx_a", task: "t", term: "term_1" }], idleHours: { ctx_a: 5 }, tasks: { t: "completed" }, dryRun: true });
    expect(await h.reaper.tick()).toEqual(["ctx_a"]);
    expect(h.closers()).toEqual([]);
    expect(h.logs[0]).toStartWith("would close ctx_a");
  });

  test("a refused close is logged, not reported closed, and nothing is killed", async () => {
    const h = harness({ workers: [{ id: "ctx_a", task: "t", term: "term_1" }], idleHours: { ctx_a: 5 }, tasks: { t: "completed" }, failStop: true });
    expect(await h.reaper.tick()).toEqual([]);
    expect(h.logs[0]).toContain("could not close ctx_a");
    expect(h.calls.every((c) => c[0] === "orchestration" || c[1] === "list")).toBe(true);
  });

  test("asks nothing further when no session is idle, and survives an unreadable Orca", async () => {
    const quiet = harness({ workers: [{ id: "ctx_a", task: "t", term: "term_1" }], idleHours: { ctx_a: 0.5 } });
    expect(await quiet.reaper.tick()).toEqual([]);
    expect(quiet.calls.some((c) => c[1] === "task-list")).toBe(false);

    const down = createIdleReaper({
      clock: () => NOW, orca: async () => ({ code: -1, stdout: "" }), watchChecks: () => [], askingDispatches: () => [], idleMs: HOUR,
    });
    expect(await down.tick()).toEqual([]);
    const throwing = createIdleReaper({
      clock: () => NOW, orca: async () => { throw new Error("boom"); }, watchChecks: () => [], askingDispatches: () => [], idleMs: HOUR,
    });
    expect(await throwing.tick()).toEqual([]);
  });
});
