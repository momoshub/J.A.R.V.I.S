import { describe, expect, test } from "bun:test";
import { createOrcaProbe } from "../../src/infrastructure/system/orcaProbe.ts";
import type { OrcaRun } from "../../src/infrastructure/system/orcaTerminal.ts";
import { RUN_NOT_FOUND, runList, STATUS_DOWN, STATUS_READY, taskList } from "../domain/orcaFixtures.ts";

/** A fake `orca` keyed on the args after the binary; records every call. */
const fakeOrca = (answers: Record<string, { code: number; stdout: string } | (() => Promise<{ code: number; stdout: string }>)>) => {
  const calls: string[][] = [];
  const run: OrcaRun = async (args) => {
    calls.push([...args]);
    const key =
      args[0] !== "orchestration" ? args[0]! : args[1] === "task-list" ? `task-list ${args[3]}` : `orchestration ${args[1]}`;
    const a = answers[key] ?? answers[key.split(" ")[0]!];
    if (!a) return { code: 1, stdout: "" };
    return typeof a === "function" ? a() : a;
  };
  return { run, calls };
};

const ok = (stdout: string) => ({ code: 0, stdout });

describe("createOrcaProbe", () => {
  test("reads status, the newest runs, and each run's tasks", async () => {
    const { run, calls } = fakeOrca({
      status: ok(STATUS_READY),
      "orchestration run-list": ok(runList([{ id: "run_a", objective: "a" }, { id: "run_b", objective: "b" }])),
      "task-list run_a": ok(taskList("run_a", [{ id: "t1", task_title: "one", status: "dispatched" }])),
      "task-list run_b": ok(taskList("run_b", [{ id: "t2", task_title: "two", status: "completed" }])),
    });
    const snap = await createOrcaProbe({ run, runScan: 7 }).read();
    expect(snap.kind).toBe("ok");
    if (snap.kind !== "ok") return;
    expect(snap.runtime.appPid).toBe(56481);
    expect(snap.tasks.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    expect(snap.unreadRuns).toBe(0);
    expect(calls[0]).toEqual(["status", "--json"]);
    expect(calls[1]).toEqual(["orchestration", "run-list", "--json", "--full", "--limit", "7"]);
    expect(calls).toContainEqual(["orchestration", "task-list", "--run", "run_a", "--json", "--full", "--brief"]);
  });

  test("a run whose task list fails is counted unread, the rest still count", async () => {
    const { run } = fakeOrca({
      status: ok(STATUS_READY),
      "orchestration run-list": ok(runList([{ id: "run_a", objective: "a" }, { id: "run_x", objective: "x" }])),
      "task-list run_a": ok(taskList("run_a", [{ id: "t1", task_title: "one", status: "blocked" }])),
      "task-list run_x": { code: 1, stdout: RUN_NOT_FOUND },
    });
    const snap = await createOrcaProbe({ run }).read();
    expect(snap).toMatchObject({ kind: "ok", unreadRuns: 1 });
    expect(snap.kind === "ok" && snap.tasks).toHaveLength(1);
  });

  test("no orca on PATH is unreachable", async () => {
    const { run, calls } = fakeOrca({ status: { code: -1, stdout: "" } });
    expect(await createOrcaProbe({ run }).read()).toEqual({ kind: "unreachable", reason: "orca CLI not found" });
    expect(calls).toHaveLength(1);
  });

  test("a runtime that is not running is unreachable, naming its state", async () => {
    const { run } = fakeOrca({ status: ok(STATUS_DOWN) });
    expect(await createOrcaProbe({ run }).read()).toEqual({ kind: "unreachable", reason: "runtime not_running" });
  });

  test("status that is not JSON is unreachable, never a throw", async () => {
    const { run } = fakeOrca({ status: { code: 1, stdout: "error: connect ECONNREFUSED" } });
    expect(await createOrcaProbe({ run }).read()).toEqual({ kind: "unreachable", reason: "orca status exited 1" });
  });

  test("a hung Orca hits the deadline and starts no more calls", async () => {
    const { run, calls } = fakeOrca({
      status: ok(STATUS_READY),
      "orchestration run-list": ok(runList(Array.from({ length: 12 }, (_, i) => ({ id: `run_${i}`, objective: `${i}` })))),
      "task-list": () => new Promise((resolve) => setTimeout(() => resolve(ok(taskList("r", []))), 60)),
    });
    const started = Date.now();
    const snap = await createOrcaProbe({ run, deadlineMs: 30 }).read();
    expect(snap).toEqual({ kind: "unreachable", reason: "timed out" });
    expect(Date.now() - started).toBeLessThan(200);
    await new Promise((r) => setTimeout(r, 100));
    // Only the first concurrent batch ever went out: 2 calls + 5 task lists.
    expect(calls.length).toBe(7);
  });

  test("a probe that throws is unreachable", async () => {
    const run: OrcaRun = async () => {
      throw new Error("boom");
    };
    expect(await createOrcaProbe({ run }).read()).toEqual({ kind: "unreachable", reason: "probe failed" });
  });
});
