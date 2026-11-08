import { describe, expect, test } from "bun:test";
import {
  deadWorkerReason,
  NO_STUCK_WORK,
  parseDispatchedTasks,
  parseOpenPrs,
  parseRunPage,
  parseSeen,
  terminalGone,
  prRef,
  quietPrs,
  REPEAT_AFTER_MS,
  stuckDm,
  toReport,
  traceStarts,
  type StuckWork,
} from "../../src/domain/stuckWork.ts";

const MIN = 60_000;

describe("orca output", () => {
  test("a run page gives its runs, when each was created, and the next cursor", () => {
    expect(
      parseRunPage(
        '{"ok":true,"result":{"runs":[{"id":"run_a","created_at":"2026-11-08T09:18:09Z"},{"id":"run_b"}],"nextCursor":"c1"}}',
      ),
    ).toEqual({ runs: [{ id: "run_a", createdAt: Date.parse("2026-11-08T09:18:09Z") }, { id: "run_b" }], next: "c1" });
    expect(parseRunPage('{"ok":true,"result":{"runs":[]}}')).toEqual({ runs: [] });
    expect(parseRunPage('{"ok":false,"error":{"code":"x"}}')).toBeUndefined();
    expect(parseRunPage("")).toBeUndefined();
  });

  test("dispatched tasks keep their dispatch and assignee, and nothing that is not dispatched", () => {
    const out = JSON.stringify({
      ok: true,
      result: {
        tasks: [
          { id: "task_1", status: "dispatched", title: "fix it", dispatchId: "ctx_aaaaaa", assignee: "term_1" },
          { id: "task_2", status: "completed", title: "done" },
          { id: "task_3", status: "dispatched", title: "bare" },
        ],
      },
    });
    expect(parseDispatchedTasks(out)).toEqual([
      { taskId: "task_1", title: "fix it", dispatchId: "ctx_aaaaaa", assignee: "term_1" },
      { taskId: "task_3", title: "bare" },
    ]);
    expect(parseDispatchedTasks("not json")).toBeUndefined();
  });

  test("a live worker is not dead, and an unanswered check is never dead", () => {
    const live = '{"ok":true,"result":{"state":"ready","stage":"input_accepted","liveness":"live"}}';
    expect(deadWorkerReason(live)).toBeUndefined();
    expect(deadWorkerReason("")).toBeUndefined();
    expect(deadWorkerReason('{"ok":false,"error":{"code":"timeout"}}')).toBeUndefined();
  });

  test("a gone worker says why", () => {
    expect(deadWorkerReason('{"ok":false,"error":{"code":"dispatch_not_found"}}')).toBe("dispatch not found");
    expect(deadWorkerReason('{"ok":true,"result":{"state":"ready","liveness":"exited"}}')).toBe("worker exited");
    expect(deadWorkerReason('{"ok":true,"result":{"state":"failed","liveness":"live"}}')).toBe("worker failed, never reported");
    expect(deadWorkerReason('{"ok":true,"result":{"state":"ready","stage":"settled"}}')).toBe("worker settled, never reported");
  });

  test("a settled worker whose process is live may be waiting on an answer, so it is not dead", () => {
    expect(deadWorkerReason('{"ok":true,"result":{"state":"ready","stage":"settled","liveness":"live"}}')).toBeUndefined();
  });

  test("a terminal is gone only on proof, never on some other error", () => {
    expect(terminalGone('{"ok":false,"error":{"code":"terminal_handle_stale"}}', "term_x")).toBe(true);
    expect(terminalGone('{"ok":false,"error":{"code":"terminal_not_found"}}', "term_x")).toBe(true);
    expect(terminalGone('{"ok":true,"result":{"terminal":{"handle":"term_x","orphaned":true}}}', "term_x")).toBe(true);
    expect(terminalGone('{"ok":true,"result":{"terminal":{"handle":"term_y"}}}', "term_x")).toBe(true);
    expect(terminalGone('{"ok":true,"result":{"terminal":{"handle":"term_x"}}}', "term_x")).toBe(false);
    expect(terminalGone('{"ok":false,"error":{"code":"runtime_not_ready"}}', "term_x")).toBe(false);
    expect(terminalGone("", "term_x")).toBe(false);
  });
});

describe("quiet PRs", () => {
  const now = Date.parse("2026-11-08T12:00:00Z");
  const pr = (number: number, fields: Record<string, unknown>) => ({
    number,
    title: `pr ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    createdAt: "2026-11-08T09:00:00Z",
    commits: [],
    comments: [],
    reviews: [],
    ...fields,
  });

  test("the last activity is the newest commit, comment or review", () => {
    const out = JSON.stringify([
      pr(1, {
        commits: [{ committedDate: "2026-11-08T10:00:00Z" }, { committedDate: "2026-11-08T11:00:00Z" }],
        comments: [{ createdAt: "2026-11-08T10:30:00Z" }],
        reviews: [{ submittedAt: "2026-11-08T11:45:00Z" }],
      }),
      pr(2, {}),
    ]);
    const prs = parseOpenPrs(out);
    expect(prs?.map((p) => p.lastActivityAt)).toEqual([Date.parse("2026-11-08T11:45:00Z"), Date.parse("2026-11-08T09:00:00Z")]);
    expect(parseOpenPrs('{"not":"a list"}')).toBeUndefined();
  });

  test("only 30 minutes of nothing counts, quietest first", () => {
    const prs = [
      { number: 1, title: "", url: "u1", lastActivityAt: now - 29 * MIN },
      { number: 2, title: "", url: "u2", lastActivityAt: now - 31 * MIN },
      { number: 3, title: "", url: "u3", lastActivityAt: now - 120 * MIN },
    ];
    expect(quietPrs(prs, now).map((p) => p.number)).toEqual([3, 2]);
  });

  test("one PR written two ways is one key", () => {
    expect(prRef("https://github.com/Cute/E.V./pull/9")).toBe(prRef("https://github.com/cute/e.v./pull/9"));
    expect(prRef("https://github.com/cute/e.v./pull/9")).toBe("cute/e.v.#9");
  });
});

describe("traceStarts", () => {
  const call = (id: string, command: string) =>
    JSON.stringify({ kind: "call", id, name: "Bash", input: JSON.stringify({ command }) });
  const result = (id: string, output: string) => JSON.stringify({ kind: "result", id, output });

  test("finds dispatches its worker-start printed, even chained after writing a brief", () => {
    const trace = [
      call("1", "cat > /tmp/brief <<'EOF'\nreview it\nEOF\norca orchestration worker-start --run run_a --spec-file /tmp/brief --json"),
      result("1", '{"ok":true,"result":{"dispatchId":"ctx_abc123","taskId":"task_x"}}'),
    ].join("\n");
    expect(traceStarts(trace).dispatches).toEqual(["ctx_abc123"]);
  });

  test("finds PRs its gh pr create printed", () => {
    const trace = [
      call("1", "GH_TOKEN=$(gh auth token -u a) gh pr create --title x --body y"),
      result("1", "https://github.com/Cute/E.V./pull/92\n"),
    ].join("\n");
    expect(traceStarts(trace).prs).toEqual(["cute/e.v.#92"]);
  });

  test("a PR or dispatch merely read is not a start", () => {
    const trace = [
      call("1", "gh pr view https://github.com/o/r/pull/5"),
      result("1", "https://github.com/o/r/pull/5 open"),
      call("2", "orca orchestration worker-show --dispatch ctx_def456 --json"),
      result("2", '{"dispatchId":"ctx_def456"}'),
      "not json",
    ].join("\n");
    expect(traceStarts(trace)).toEqual({ dispatches: [], prs: [] });
  });
});

describe("repeats", () => {
  const now = 10 * REPEAT_AFTER_MS;
  const work: StuckWork = {
    tasks: [{ taskId: "task_1", runId: "run_a", title: "t", why: "worker exited" }],
    prs: [{ number: 5, title: "p", url: "https://github.com/o/r/pull/5", lastActivityAt: 0 }],
    problems: [],
  };

  test("a new item is reported and remembered", () => {
    const { fresh, seen } = toReport(work, {}, now);
    expect(fresh.tasks).toHaveLength(1);
    expect(fresh.prs).toHaveLength(1);
    expect(seen).toEqual({ "task:task_1": now, "pr:o/r#5": now });
  });

  test("an item reported within the window is not repeated, and comes back after it", () => {
    const recent = { "task:task_1": now - REPEAT_AFTER_MS + 1, "pr:o/r#5": now - REPEAT_AFTER_MS };
    const { fresh, seen } = toReport(work, recent, now);
    expect(fresh.tasks).toHaveLength(0);
    expect(fresh.prs.map((p) => p.number)).toEqual([5]);
    expect(seen["task:task_1"]).toBe(now - REPEAT_AFTER_MS + 1);
    expect(seen["pr:o/r#5"]).toBe(now);
  });

  test("old records are dropped so the record cannot grow forever", () => {
    const { seen } = toReport(NO_STUCK_WORK, { "task:gone": now - REPEAT_AFTER_MS - 1 }, now);
    expect(seen).toEqual({});
  });

  test("a malformed record is forgotten, not fatal", () => {
    expect(parseSeen("{oops")).toEqual({});
    expect(parseSeen('{"a":1,"b":"x"}')).toEqual({ a: 1 });
    expect(parseSeen(undefined)).toEqual({});
  });
});

describe("stuckDm", () => {
  const now = 1_000 * MIN;

  test("nothing new is no DM, even when something could not be checked", () => {
    expect(stuckDm(NO_STUCK_WORK, now, "X/jv")).toBeUndefined();
    expect(stuckDm({ tasks: [], prs: [], problems: ["Orca (not running)"] }, now, "X/jv")).toBeUndefined();
  });

  test("lists each item with the thread that owns it", () => {
    const text =
      stuckDm(
        {
          tasks: [
            { taskId: "task_1", runId: "run_a", title: "review PR 9", why: "worker exited", owner: { channelId: "C1", threadTs: "1.2" } },
          ],
          prs: [{ number: 9, title: "fix x", url: "https://github.com/o/r/pull/9", lastActivityAt: now - 45 * MIN }],
          problems: [],
        },
        now,
        "X/jv",
        "acme",
      ) ?? "";
    expect(text).toContain("`task_1` \"review PR 9\" - worker exited - <https://acme.slack.com/archives/C1/p12|thread>");
    expect(text).toContain("<https://github.com/o/r/pull/9|#9> \"fix x\" - quiet 45m - no thread");
    expect(text).toContain("`X/jv mindful`");
  });
});
