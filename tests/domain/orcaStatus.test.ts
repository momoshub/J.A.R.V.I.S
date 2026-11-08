import { describe, expect, test } from "bun:test";
import {
  describeOrca,
  LIVE_TEXT_ROWS,
  type OrcaSnapshot,
  orcaTime,
  parseOrcaStatus,
  parseRunList,
  parseTaskList,
  summarizeOrca,
} from "../../src/domain/orcaStatus.ts";
import { RUN_NOT_FOUND, runList, STATUS_DOWN, STATUS_READY, taskList } from "./orcaFixtures.ts";

const NOW = Date.parse("2026-11-08T10:57:36Z");
const runtime = { reachable: true, state: "ready", appRunning: true, appPid: 56481, version: "1.4.253" };

describe("orcaTime", () => {
  test("reads SQLite's UTC stamp and ISO alike", () => {
    expect(orcaTime("2026-11-08 09:57:36")).toBe(Date.parse("2026-11-08T09:57:36Z"));
    expect(orcaTime("2026-11-08T09:57:36Z")).toBe(Date.parse("2026-11-08T09:57:36Z"));
    expect(orcaTime("2026-11-08T09:57:36+07:00")).toBe(Date.parse("2026-11-08T02:57:36Z"));
  });

  test("anything else is unknown, not zero", () => {
    expect(orcaTime(undefined)).toBeUndefined();
    expect(orcaTime("yesterday")).toBeUndefined();
    expect(orcaTime(12)).toBeUndefined();
  });
});

describe("parseOrcaStatus", () => {
  test("a ready runtime with its app pid and version", () => {
    expect(parseOrcaStatus(STATUS_READY)).toEqual(runtime);
  });

  test("a runtime that is not reachable says so", () => {
    expect(parseOrcaStatus(STATUS_DOWN)).toEqual({ reachable: false, state: "not_running", appRunning: false });
  });

  test("garbage or an error answer is undefined, never a throw", () => {
    expect(parseOrcaStatus("")).toBeUndefined();
    expect(parseOrcaStatus("Orca is not running")).toBeUndefined();
    expect(parseOrcaStatus(RUN_NOT_FOUND)).toBeUndefined();
    expect(parseOrcaStatus('{"ok":true,"result":{}}')).toBeUndefined();
  });
});

describe("parseRunList", () => {
  test("runs newest first, and whether Orca has more", () => {
    const out = parseRunList(runList([{ id: "run_a", objective: "sys command" }], "cursor"));
    expect(out).toEqual({
      runs: [{ id: "run_a", objective: "sys command", createdAt: Date.parse("2026-11-08T09:57:36Z") }],
      more: true,
    });
    expect(parseRunList(runList([]))).toEqual({ runs: [], more: false });
  });

  test("a row with no id is skipped, an untitled one falls back to its id", () => {
    const raw = JSON.stringify({ ok: true, result: { runs: [{ objective: "x" }, { id: "run_b" }] } });
    expect(parseRunList(raw)?.runs).toEqual([{ id: "run_b", objective: "run_b" }]);
  });

  test("not a run list is undefined", () => {
    expect(parseRunList(RUN_NOT_FOUND)).toBeUndefined();
    expect(parseRunList("{")).toBeUndefined();
  });
});

describe("parseTaskList", () => {
  test("title, status and age from the full view", () => {
    const rows = parseTaskList(taskList("run_a", [{ id: "task_1", task_title: "sys: orca", status: "dispatched" }]), "run_a");
    expect(rows).toEqual([
      { id: "task_1", runId: "run_a", title: "sys: orca", status: "dispatched", createdAt: Date.parse("2026-11-08T09:57:36Z") },
    ]);
  });

  test("the concise view (title, no run or time) still parses", () => {
    const raw = JSON.stringify({ ok: true, result: { tasks: [{ id: "task_2", status: "blocked", title: "ask" }], runId: "run_b" } });
    expect(parseTaskList(raw, "run_b")).toEqual([{ id: "task_2", runId: "run_b", title: "ask", status: "blocked" }]);
  });

  test("an error answer is undefined, not an empty run", () => {
    expect(parseTaskList(RUN_NOT_FOUND, "run_x")).toBeUndefined();
  });
});

const snap = (tasks: { id: string; runId?: string; status: string; title?: string; createdAt?: number }[]): OrcaSnapshot => ({
  kind: "ok",
  runtime,
  runs: [
    { id: "run_a", objective: "sys command" },
    { id: "run_b", objective: "review PR 99" },
  ],
  tasks: tasks.map((t) => ({ runId: "run_a", title: t.id, ...t })),
  unreadRuns: 0,
  moreRuns: false,
});

describe("summarizeOrca", () => {
  test("counts by status and lists live workers oldest first", () => {
    const s = summarizeOrca(
      snap([
        { id: "t1", status: "dispatched", createdAt: NOW - 600_000 },
        { id: "t2", status: "blocked", runId: "run_b", createdAt: NOW - 3_600_000 },
        { id: "t3", status: "completed" },
        { id: "t4", status: "failed", runId: "run_b" },
        { id: "t5", status: "pending" },
        { id: "t6", status: "ready" },
      ]),
      NOW,
    );
    if (s.kind !== "ok") throw new Error("expected ok");
    expect(s.counts).toEqual({ running: 1, waiting: 1, queued: 2, completed: 1, failed: 1 });
    expect(s.activeRuns).toBe(2);
    expect(s.live).toEqual([
      { title: "t2", run: "review PR 99", status: "waiting", ageS: 3600 },
      { title: "t1", run: "sys command", status: "running", ageS: 600 },
    ]);
  });

  test("a run whose tasks are all settled is not active", () => {
    const s = summarizeOrca(snap([{ id: "t1", status: "completed" }, { id: "t2", status: "failed" }]), NOW);
    expect(s.kind === "ok" && s.activeRuns).toBe(0);
  });

  test("empty: no runs, no tasks", () => {
    const s = summarizeOrca({ kind: "ok", runtime, runs: [], tasks: [], unreadRuns: 0, moreRuns: false }, NOW);
    expect(s).toMatchObject({ kind: "ok", activeRuns: 0, scannedRuns: 0, live: [] });
  });

  test("unreachable passes straight through", () => {
    expect(summarizeOrca({ kind: "unreachable", reason: "timed out" }, NOW)).toEqual({ kind: "unreachable", reason: "timed out" });
  });
});

describe("describeOrca", () => {
  test("unreachable is one line", () => {
    expect(describeOrca({ kind: "unreachable", reason: "orca CLI not found" })).toEqual([
      "*orca* unreachable (orca CLI not found)",
    ]);
  });

  test("reachable: runtime, counts, then the live workers", () => {
    const lines = describeOrca(
      summarizeOrca(snap([{ id: "fix the thing", status: "dispatched", createdAt: NOW - 120_000 }, { id: "t3", status: "completed" }]), NOW),
    );
    expect(lines[0]).toBe("*orca* ready, app pid 56481, v1.4.253 - 1 active run: 1 running, 1 completed");
    expect(lines[1]).toBe("- fix the thing (sys command, 2m)");
    expect(lines).toHaveLength(2);
  });

  test("many workers: capped, with the rest counted", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, status: i % 3 ? "dispatched" : "blocked", createdAt: NOW - i * 1000 }));
    const lines = describeOrca(summarizeOrca(snap(many), NOW));
    expect(lines).toHaveLength(1 + LIVE_TEXT_ROWS + 1);
    expect(lines.at(-1)).toBe(`- and ${12 - LIVE_TEXT_ROWS} more`);
    expect(lines[0]).toContain("8 running, 4 waiting for input");
    expect(lines.some((l) => l.includes("waiting for input)"))).toBe(true);
  });

  test("says when the counts may be short", () => {
    const s = summarizeOrca({ ...snap([]), unreadRuns: 2, moreRuns: true } as OrcaSnapshot, NOW);
    expect(describeOrca(s)[0]).toContain("_(latest 2 runs, 2 unread)_");
  });
});
