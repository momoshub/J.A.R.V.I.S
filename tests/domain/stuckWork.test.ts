import { describe, expect, test } from "bun:test";
import {
  deadWorkerReason,
  NO_STUCK_WORK,
  parseDispatchedTasks,
  parseOpenPrs,
  parseRunPage,
  parseSeen,
  parsePrThreads,
  recordedOwners,
  recordPrThread,
  PR_THREADS_MAX,
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
  });

  test("settled is not proof: live, unverifiable or no liveness may be a worker waiting on an answer", () => {
    expect(deadWorkerReason('{"ok":true,"result":{"state":"ready","stage":"settled","liveness":"live"}}')).toBeUndefined();
    expect(deadWorkerReason('{"ok":true,"result":{"state":"ready","stage":"settled","liveness":"unverifiable"}}')).toBeUndefined();
    expect(deadWorkerReason('{"ok":true,"result":{"state":"ready","stage":"settled"}}')).toBeUndefined();
    expect(deadWorkerReason('{"ok":true,"result":{"state":"ready","stage":"settled","liveness":"exited"}}')).toBe("worker exited");
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
      { number: 1, title: "", url: "u1", lastActivityAt: now - 29 * MIN, awaitingHuman: false },
      { number: 2, title: "", url: "u2", lastActivityAt: now - 31 * MIN, awaitingHuman: false },
      { number: 3, title: "", url: "u3", lastActivityAt: now - 120 * MIN, awaitingHuman: false },
      { number: 4, title: "", url: "u4", lastActivityAt: now - 600 * MIN, awaitingHuman: true },
    ];
    expect(quietPrs(prs, now).map((p) => p.number)).toEqual([3, 2]);
  });

  describe("waiting on a person is not quiet", () => {
    const green = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "StatusContext", state: "SUCCESS" }];
    const waits = (fields: Record<string, unknown>) => parseOpenPrs(JSON.stringify([pr(1, fields)]))?.[0]?.awaitingHuman;

    test("green checks on a PR ready for review: the reviewer's ball (the #16 case)", () => {
      expect(waits({ statusCheckRollup: green, reviewDecision: "REVIEW_REQUIRED", isDraft: false })).toBe(true);
      expect(waits({ statusCheckRollup: green, reviewDecision: "" })).toBe(true);
      expect(waits({ statusCheckRollup: [{ conclusion: "SKIPPED" }, { conclusion: "NEUTRAL" }] })).toBe(true);
    });

    test("approved: only a merge is left, which is a human's", () => {
      expect(waits({ reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "FAILURE" }] })).toBe(true);
    });

    test("changes requested, a draft, failing or running checks: still the author's ball", () => {
      expect(waits({ statusCheckRollup: green, reviewDecision: "CHANGES_REQUESTED" })).toBe(false);
      expect(waits({ statusCheckRollup: green, isDraft: true })).toBe(false);
      expect(waits({ statusCheckRollup: [...green, { conclusion: "FAILURE" }] })).toBe(false);
      expect(waits({ statusCheckRollup: [...green, { status: "IN_PROGRESS", conclusion: "" }] })).toBe(false);
      expect(waits({ statusCheckRollup: [{ state: "PENDING" }] })).toBe(false);
    });

    test("no checks: only the author's own last comment, newer than the last commit, is a question to someone", () => {
      const commits = [{ committedDate: "2026-11-08T09:30:00Z" }];
      const bot = { author: { login: "jarvis[bot]" } };
      const ask = { ...bot, createdAt: "2026-11-08T10:00:00Z" };
      expect(waits({ ...bot, commits, comments: [ask], statusCheckRollup: [] })).toBe(true);
      expect(waits({ ...bot, commits, comments: [{ author: { login: "kai" }, createdAt: "2026-11-08T10:00:00Z" }], statusCheckRollup: [] })).toBe(false);
      expect(waits({ ...bot, commits: [{ committedDate: "2026-11-08T11:00:00Z" }], comments: [ask], statusCheckRollup: [] })).toBe(false);
      expect(waits({ ...bot, commits, comments: [], statusCheckRollup: [] })).toBe(false);
      expect(waits({ ...bot, commits, comments: [ask] })).toBe(true);
    });
  });

  test("one PR written two ways is one key", () => {
    expect(prRef("https://github.com/Cute/J.A.R.V.I.S./pull/9")).toBe(prRef("https://github.com/cute/j.a.r.v.i.s./pull/9"));
    expect(prRef("https://github.com/cute/j.a.r.v.i.s./pull/9")).toBe("cute/j.a.r.v.i.s.#9");
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
      result("1", "https://github.com/Cute/J.A.R.V.I.S./pull/92\n"),
    ].join("\n");
    expect(traceStarts(trace).prs).toEqual(["cute/j.a.r.v.i.s.#92"]);
  });

  test("finds PRs opened through the app's helper, which is how the bot opens its own", () => {
    const trace = [
      call("1", "bin/github-app.sh pr-create momoshub/J.A.R.V.I.S. --head h --base main --title t --body-file /tmp/b"),
      result("1", '{"url":"https://github.com/momoshub/J.A.R.V.I.S./pull/16","number":16}'),
    ].join("\n");
    expect(traceStarts(trace).prs).toEqual(["momoshub/j.a.r.v.i.s.#16"]);
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

describe("recorded PR threads", () => {
  const url = "https://github.com/Momoshub/J.A.R.V.I.S./pull/16";

  test("a PR opened from a thread is remembered by its normalized ref and read back as an owner", () => {
    const json = recordPrThread(undefined, url, { channelId: "C1", threadTs: "100.2" });
    expect(parsePrThreads(json)).toEqual({ "momoshub/j.a.r.v.i.s.#16": "C1/100.2" });
    expect(recordedOwners(json).get(prRef(url))).toEqual({ channelId: "C1", threadTs: "100.2" });
  });

  test("the same PR again replaces its record, and only the newest are kept", () => {
    let json = recordPrThread(undefined, url, { channelId: "C1", threadTs: "1.1" });
    json = recordPrThread(json, url, { channelId: "C2", threadTs: "2.2" });
    expect(Object.keys(parsePrThreads(json))).toHaveLength(1);
    expect(recordedOwners(json).get(prRef(url))).toEqual({ channelId: "C2", threadTs: "2.2" });
    for (let i = 0; i < PR_THREADS_MAX + 5; i++) json = recordPrThread(json, `https://github.com/o/r/pull/${i + 100}`, { channelId: "C", threadTs: `${i}.0` });
    const kept = parsePrThreads(json);
    expect(Object.keys(kept)).toHaveLength(PR_THREADS_MAX);
    expect(kept["momoshub/j.a.r.v.i.s.#16"]).toBeUndefined();
  });

  test("malformed storage is forgotten, never thrown", () => {
    expect(parsePrThreads("nope")).toEqual({});
    expect(parsePrThreads('{"a":1,"b":"no-slash"}')).toEqual({});
    expect(recordedOwners('{"o/r#1":"C1/"}').size).toBe(0);
  });
});
