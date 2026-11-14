import { describe, expect, test } from "bun:test";
import {
  type Candidate,
  countGates,
  judge,
  orcaIdsIn,
  parseTerminalList,
  parseWorkerList,
  type ReapContext,
  selectIdle,
  type WorkerRow,
} from "../../src/domain/idleWorkers.ts";

const NOW = 1_000_000_000_000;
const HOUR = 3_600_000;
const ctx = (over: Partial<ReapContext> = {}): ReapContext => ({
  now: NOW,
  idleMs: 3 * HOUR,
  watched: new Set(),
  asking: new Set(),
  ...over,
});

const worker = (over: Partial<WorkerRow> = {}): WorkerRow => ({
  dispatchId: "ctx_a",
  taskId: "task_a",
  runId: "run_a",
  state: "ready",
  handle: "term_a",
  terminalState: "active",
  keptOpen: false,
  needsAttention: false,
  liveness: "live",
  ...over,
});

const cand = (over: Partial<Candidate> = {}, w: Partial<WorkerRow> = {}, idleH = 5): Candidate => {
  const worker_ = worker(w);
  return { worker: worker_, terminal: { handle: worker_.handle, orphaned: false, lastOutputAt: NOW - idleH * HOUR }, taskStatus: "completed", ...over };
};

describe("judge", () => {
  test("an idle worker whose task finished or failed is eligible", () => {
    expect(judge(cand(), ctx())).toMatchObject({ reap: true, why: "task completed", settled: false });
    expect(judge(cand({ taskStatus: "failed" }), ctx())).toMatchObject({ reap: true, why: "task failed" });
  });

  test("a settled worker is flagged so it is released, not stopped", () => {
    expect(judge(cand({}, { state: "succeeded" }), ctx())).toMatchObject({ reap: true, settled: true });
  });

  test("idle time is measured against the threshold", () => {
    expect(judge(cand({}, {}, 2.9), ctx())).toEqual({ reap: false, why: "not idle long enough" });
    expect(judge(cand({}, {}, 3), ctx())).toMatchObject({ reap: true });
  });

  test("a worker not tied to any task is eligible", () => {
    const c = cand({ taskStatus: undefined });
    expect(judge({ ...c, worker: { ...c.worker, taskId: undefined } }, ctx())).toMatchObject({ reap: true, why: "not tied to a task" });
  });

  test("a task still running is never reaped, even idle for days", () => {
    expect(judge(cand({ taskStatus: "dispatched" }, {}, 72), ctx())).toEqual({ reap: false, why: "task still dispatched" });
    expect(judge(cand({ taskStatus: undefined }), ctx())).toEqual({ reap: false, why: "task status unreadable" });
  });

  test("a blocked task is closable only once its worker ended, and needs zero pending gates", () => {
    const ended = { state: "stopped" };
    expect(judge(cand({ taskStatus: "blocked", pendingGates: 0 }, ended), ctx())).toMatchObject({ reap: true, why: "task blocked with nothing pending", settled: false });
    expect(judge(cand({ taskStatus: "blocked", pendingGates: 0 }, { state: "succeeded" }), ctx())).toMatchObject({ reap: true, settled: true });
    expect(judge(cand({ taskStatus: "blocked", pendingGates: 1 }, ended), ctx())).toMatchObject({ reap: false });
    expect(judge(cand({ taskStatus: "blocked" }, ended), ctx())).toMatchObject({ reap: false, why: "pending gates unreadable" });
  });

  test("a worker parked on an ask (task blocked, no gate, worker still going) is never closed", () => {
    // Orca leaves such a task blocked with zero gates, and the question may come from a coordinator the bot does not know.
    expect(judge(cand({ taskStatus: "blocked", pendingGates: 0 }, { state: "ready" }, 72), ctx())).toEqual({
      reap: false,
      why: "task blocked while its worker is still going",
    });
  });

  test("a watch on the worker's Run or task protects it, not only one naming its dispatch", () => {
    expect(judge(cand(), ctx({ watched: new Set(["run_a"]) }))).toEqual({ reap: false, why: "a watch is on it" });
    expect(judge(cand(), ctx({ watched: new Set(["task_a"]) }))).toEqual({ reap: false, why: "a watch is on it" });
    expect(judge(cand(), ctx({ watched: new Set(["run_other", "task_other"]) }))).toMatchObject({ reap: true });
  });

  test("a terminal reused by another dispatch is not closed through the old one", () => {
    expect(judge(cand({}, { ownerDispatchId: "ctx_new" }), ctx())).toEqual({ reap: false, why: "its terminal was reused by another dispatch" });
    expect(judge(cand({}, { ownerDispatchId: "ctx_a" }), ctx())).toMatchObject({ reap: true });
    expect(judge(cand({ sharedHandle: true }), ctx())).toEqual({ reap: false, why: "another worker uses the same terminal" });
  });

  test("a live watch or an unanswered question protects the worker", () => {
    expect(judge(cand(), ctx({ watched: new Set(["ctx_a"]) }))).toEqual({ reap: false, why: "a watch is on it" });
    expect(judge(cand(), ctx({ asking: new Set(["ctx_a"]) }))).toEqual({ reap: false, why: "a question is waiting for an answer" });
  });

  test("kept-open, about-to-be-released, attention and unproven sessions are skipped", () => {
    expect(judge(cand({}, { keptOpen: true }), ctx())).toMatchObject({ reap: false });
    expect(judge(cand({}, { autoReleaseAt: NOW + 1000 }), ctx())).toMatchObject({ reap: false });
    expect(judge(cand({}, { needsAttention: true }), ctx())).toMatchObject({ reap: false });
    expect(judge(cand({}, { liveness: "unverifiable" }), ctx())).toMatchObject({ reap: false });
    expect(judge(cand({}, { terminalState: "released" }), ctx())).toEqual({ reap: false, why: "already closed" });
  });

  test("a terminal Orca does not list, a mismatched handle or one with no output time is skipped", () => {
    expect(judge(cand({ terminal: undefined }), ctx())).toMatchObject({ reap: false });
    expect(judge(cand({ terminal: { handle: "term_other", orphaned: false, lastOutputAt: 0 } }), ctx())).toMatchObject({ reap: false });
    expect(judge(cand({ terminal: { handle: "term_a", orphaned: true, lastOutputAt: 0 } }), ctx())).toMatchObject({ reap: false });
    expect(judge(cand({ terminal: { handle: "term_a", orphaned: false } }), ctx())).toMatchObject({ reap: false });
  });
});

describe("selectIdle", () => {
  test("keeps only eligible sessions, longest idle first", () => {
    const picked = selectIdle(
      [
        cand({}, { dispatchId: "ctx_1", handle: "term_1" }, 4),
        cand({}, { dispatchId: "ctx_2", handle: "term_2" }, 30),
        cand({ taskStatus: "dispatched" }, { dispatchId: "ctx_3", handle: "term_3" }, 30),
        cand({}, { dispatchId: "ctx_4", handle: "term_4" }, 1),
      ],
      ctx(),
    );
    expect(picked.map((p) => p.dispatchId)).toEqual(["ctx_2", "ctx_1"]);
  });
});

describe("parsers", () => {
  const workerJson = JSON.stringify({
    ok: true,
    result: {
      workers: [
        {
          dispatchId: "ctx_x",
          taskId: "task_x",
          runId: "run_x",
          workerState: "succeeded",
          agentTerminalHandle: "term_x",
          terminalState: "reclaimable",
          resource: { retainedReason: null, ownerDispatchId: "ctx_x", autoReleaseAt: "2026-11-14T05:59:31Z" },
          projection: { attention: { categories: [], requiresAction: false }, liveness: { verdict: "live" } },
        },
        { dispatchId: "ctx_nohandle" },
        { dispatchId: "ctx_y", agentTerminalHandle: "term_y", resource: { retainedReason: "user" }, projection: {} },
      ],
      page: { hasMore: true, nextCursor: "abc" },
    },
  });

  test("parseWorkerList reads rows, skips the unusable ones and defaults unknown attention to 'needs it'", () => {
    const parsed = parseWorkerList(workerJson);
    expect(parsed?.next).toBe("abc");
    expect(parsed?.workers).toHaveLength(2);
    expect(parsed?.workers[0]).toMatchObject({
      dispatchId: "ctx_x", taskId: "task_x", runId: "run_x", state: "succeeded", handle: "term_x",
      keptOpen: false, needsAttention: false, liveness: "live", ownerDispatchId: "ctx_x", autoReleaseAt: Date.parse("2026-11-14T05:59:31Z"),
    });
    expect(parsed?.workers[1]).toMatchObject({ keptOpen: true, needsAttention: true, liveness: "unknown" });
  });

  test("garbage and failures parse to undefined", () => {
    expect(parseWorkerList("nope")).toBeUndefined();
    expect(parseWorkerList('{"ok":false}')).toBeUndefined();
    expect(parseTerminalList("")).toBeUndefined();
    expect(countGates("{}")).toBeUndefined();
  });

  test("parseTerminalList and countGates", () => {
    const rows = parseTerminalList(JSON.stringify({ ok: true, result: { terminals: [{ handle: "term_1", lastOutputAt: 5, orphaned: false }, { handle: "term_2", orphaned: true }, {}] } }));
    expect(rows).toEqual([{ handle: "term_1", orphaned: false, lastOutputAt: 5 }, { handle: "term_2", orphaned: true }]);
    expect(countGates('{"ok":true,"result":{"gates":[{},{}]}}')).toBe(2);
  });

  test("orcaIdsIn finds dispatch, Run and task ids in a watch's shell check", () => {
    expect(orcaIdsIn("bun bin/orca-worker-wait.ts ctx_ab12 --past-wait")).toEqual(["ctx_ab12"]);
    expect(orcaIdsIn("orca orchestration task-list --run run_9f3c --json | jq task_77")).toEqual(["run_9f3c", "task_77"]);
    expect(orcaIdsIn("gh pr checks 12; bin_run_x")).toEqual([]);
  });
});
