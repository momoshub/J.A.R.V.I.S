import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { createStuckWorkProbe, findOwners, type TraceCache } from "../../src/infrastructure/system/stuckWorkProbe.ts";
import type { CommandRunner } from "../../src/infrastructure/llm/backgroundAgents.ts";

const NOW = Date.parse("2026-11-08T12:00:00Z");

const traceDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "stuck-"));
  const call = (id: string, command: string) =>
    JSON.stringify({ kind: "call", id, name: "Bash", input: JSON.stringify({ command }) });
  const result = (id: string, output: string) => JSON.stringify({ kind: "result", id, output });
  mkdirSync(join(dir, "C1"));
  writeFileSync(
    join(dir, "C1", "100.1.jsonl"),
    [
      call("a", "orca orchestration worker-start --run run_1 --spec x --json"),
      result("a", '{"ok":true,"result":{"dispatchId":"ctx_dead01"}}'),
      call("b", "gh pr create --title t --body b"),
      result("b", "https://github.com/o/r/pull/7"),
    ].join("\n"),
  );
  return dir;
};

const orcaFake = (answers: Record<string, string>) => {
  const calls: string[] = [];
  return {
    calls,
    run: async (args: readonly string[]) => {
      const key = args.join(" ");
      calls.push(key);
      const hit = Object.entries(answers).find(([k]) => key.startsWith(k));
      return hit ? { code: 0, stdout: hit[1] } : { code: 1, stdout: "" };
    },
  };
};

const ghFake = (stdout: string, code = 0): CommandRunner => async () => ({ code, stdout, stderr: code ? "auth failed" : "" });

const prs = JSON.stringify([
  { number: 7, title: "quiet one", url: "https://github.com/o/r/pull/7", createdAt: "2026-11-08T10:00:00Z", commits: [], comments: [], reviews: [] },
  { number: 8, title: "busy one", url: "https://github.com/o/r/pull/8", createdAt: "2026-11-08T11:50:00Z", commits: [], comments: [], reviews: [] },
]);

describe("stuck work probe", () => {
  test("finds a dispatched task with a dead worker and a quiet PR, each with its thread", async () => {
    const orca = orcaFake({
      "orchestration run-list": JSON.stringify({
        ok: true,
        result: {
          runs: [
            { id: "run_1", created_at: "2026-11-08T11:00:00Z" },
            { id: "run_2" },
            { id: "run_old", created_at: "2026-11-01T11:00:00Z" },
          ],
          nextCursor: "more",
        },
      }),
      "orchestration task-list --run run_1": JSON.stringify({
        ok: true,
        result: {
          tasks: [
            { id: "task_dead", status: "dispatched", title: "review", dispatchId: "ctx_dead01" },
            { id: "task_live", status: "dispatched", title: "busy", dispatchId: "ctx_live01" },
          ],
        },
      }),
      "orchestration task-list --run run_2": '{"ok":true,"result":{"tasks":[{"id":"task_t","status":"dispatched","title":"by hand","assignee":"term_x"}]}}',
      "orchestration worker-show --dispatch ctx_dead01": '{"ok":true,"result":{"state":"ready","liveness":"exited"}}',
      "orchestration worker-show --dispatch ctx_live01": '{"ok":true,"result":{"state":"ready","liveness":"live"}}',
      "terminal show --terminal term_x": '{"ok":false,"error":{"code":"terminal_not_found"}}',
    });
    const probe = createStuckWorkProbe({ orca: orca.run, gh: ghFake(prs), traceDir: traceDir(), now: () => NOW });
    const work = await probe.scan();
    expect(work.problems).toEqual([]);
    expect(work.tasks).toEqual([
      { taskId: "task_dead", runId: "run_1", title: "review", why: "worker exited", dispatchId: "ctx_dead01", owner: { channelId: "C1", threadTs: "100.1" } },
      { taskId: "task_t", runId: "run_2", title: "by hand", why: "its terminal is gone" },
    ]);
    expect(work.prs.map((p) => [p.number, p.owner])).toEqual([[7, { channelId: "C1", threadTs: "100.1" }]]);
    // A run older than the window is not looked into, and ends the walk.
    expect(orca.calls.some((c) => c.includes("run_old"))).toBe(false);
    expect(orca.calls.filter((c) => c.startsWith("orchestration run-list"))).toHaveLength(1);
  });

  test("Orca down and gh failing are problems, never 'nothing stuck'", async () => {
    const probe = createStuckWorkProbe({ orca: orcaFake({}).run, gh: ghFake("", 1), traceDir: "/nonexistent", now: () => NOW });
    const work = await probe.scan();
    expect(work.tasks).toEqual([]);
    expect(work.prs).toEqual([]);
    expect(work.problems.join(" ")).toContain("Orca");
    expect(work.problems.join(" ")).toContain("gh pr list");
  });

  test("an unanswered worker-show is not reported as dead", async () => {
    const orca = orcaFake({
      "orchestration run-list": '{"ok":true,"result":{"runs":[{"id":"run_1"}]}}',
      "orchestration task-list --run run_1": '{"ok":true,"result":{"tasks":[{"id":"t","status":"dispatched","title":"x","dispatchId":"ctx_slow01"}]}}',
    });
    const probe = createStuckWorkProbe({ orca: orca.run, gh: ghFake("[]"), traceDir: "/nonexistent", now: () => NOW });
    expect((await probe.scan()).tasks).toEqual([]);
  });

  test("a task with no dispatch is not reported when Orca answers some other error", async () => {
    const orca = orcaFake({
      "orchestration run-list": '{"ok":true,"result":{"runs":[{"id":"run_1"}]}}',
      "orchestration task-list --run run_1": '{"ok":true,"result":{"tasks":[{"id":"t","status":"dispatched","title":"x","assignee":"term_x"}]}}',
      "terminal show --terminal term_x": '{"ok":false,"error":{"code":"runtime_not_ready"}}',
    });
    const probe = createStuckWorkProbe({ orca: orca.run, gh: ghFake("[]"), traceDir: "/nonexistent", now: () => NOW });
    expect((await probe.scan()).tasks).toEqual([]);
  });

  test("PRs are read least recently updated first, and hitting the limit is said", async () => {
    const seen: string[][] = [];
    const many = JSON.stringify(
      Array.from({ length: 25 }, (_, i) => ({
        number: i + 1, title: "", url: `https://github.com/o/r/pull/${i + 1}`, createdAt: "2026-11-08T11:59:00Z", commits: [], comments: [], reviews: [],
      })),
    );
    const gh: CommandRunner = async (cmd) => {
      seen.push([...cmd]);
      return { code: 0, stdout: many, stderr: "" };
    };
    const probe = createStuckWorkProbe({ orca: orcaFake({}).run, gh, traceDir: "/nonexistent", now: () => NOW });
    const work = await probe.scan();
    expect(seen[0]?.join(" ")).toContain("--search sort:updated-asc");
    expect(work.problems.join(" ")).toContain("past the 25 least recently updated");
  });

  test("a trace is parsed again only once it changed", () => {
    const dir = traceDir();
    const cache: TraceCache = new Map();
    expect(findOwners(dir, 0, cache).prs.get("o/r#7")).toEqual({ channelId: "C1", threadTs: "100.1" });
    const before = cache.get("C1/100.1");
    findOwners(dir, 0, cache);
    expect(cache.get("C1/100.1")?.started).toBe(before?.started);
    appendFileSync(
      join(dir, "C1", "100.1.jsonl"),
      "\n" + JSON.stringify({ kind: "call", id: "c", name: "Bash", input: JSON.stringify({ command: "gh pr create" }) }) +
        "\n" + JSON.stringify({ kind: "result", id: "c", output: "https://github.com/o/r/pull/8" }),
    );
    expect(findOwners(dir, 0, cache).prs.has("o/r#8")).toBe(true);
    expect(findOwners(dir, Date.now() + 60_000, cache).prs.size).toBe(0);
    expect(cache.size).toBe(0);
  });
});
