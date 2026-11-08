import { describe, expect, test } from "bun:test";
import {
  backgroundLaunches,
  describeBackground,
  liveClaudeSessions,
  mayStopLaunch,
  NOTHING_IN_BACKGROUND,
  orcaWorkerLiveness,
  parseAgentsList,
  stopReply,
} from "../../src/domain/threadBackground.ts";

let n = 0;
/** One Bash call and its result, as the trace log writes them. */
const bash = (command: string, output: string, actor = "U1", name = "Bash"): string => {
  const id = `toolu_${++n}`;
  return [
    JSON.stringify({ at: "t", actor, run: "chat", kind: "call", id, name, input: JSON.stringify({ command }) }),
    JSON.stringify({ at: "t", actor, run: "chat", kind: "result", id, isError: false, output }),
  ].join("\n");
};

const BG_OUT = "backgrounded · cfaf8d7a\n  claude agents             list sessions\n  claude stop cfaf8d7a      stop this session";

describe("backgroundLaunches", () => {
  test("a claude --bg the thread ran counts, with who ran it", () => {
    const trace = bash('cd /repo && FOO=1 claude --bg --model haiku "do the thing"', BG_OUT, "U-kai");
    expect(backgroundLaunches(trace)).toEqual([{ kind: "claude-bg", id: "cfaf8d7a", actor: "U-kai" }]);
  });

  test("the launcher by full path, --background, and behind nohup all count", () => {
    const trace = [
      bash("/opt/homebrew/bin/claude --bg x", "backgrounded · 11111111"),
      bash("claude --background x", "backgrounded · 22222222"),
      bash("nohup claude --bg x", "backgrounded · 33333333"),
    ].join("\n");
    expect(backgroundLaunches(trace).map((l) => l.id)).toEqual(["11111111", "22222222", "33333333"]);
  });

  test("reading about a launch is not a launch", () => {
    // A turn grepping logs names the launcher in a quoted pattern, and the
    // output can carry another thread's ids - neither may be stopped from here.
    const trace = [
      bash('grep -r "claude --bg" logs/threads', "backgrounded · aaaaaaaa"),
      bash("claude agents --json", '[{"id":"bbbbbbbb","kind":"background"}]'),
      bash("cat notes.txt", "backgrounded · cccccccc"),
      bash("ps ax | grep 'claude --bg-pty-host'", "backgrounded · dddddddd"),
      bash("claude --bg x", "error: workspace not trusted"),
    ].join("\n");
    expect(backgroundLaunches(trace)).toEqual([]);
  });

  test("only Bash calls launch anything", () => {
    expect(backgroundLaunches(bash("claude --bg x", BG_OUT, "U1", "Read"))).toEqual([]);
  });

  test("an Orca worker-start counts by the dispatch it printed", () => {
    const json =
      '{"ok":true,"result":{"dispatchId":"ctx_0b5c88964b58","taskId":"task_d57f","runId":"run_2543","state":"ready"}}';
    const trace = [
      bash("orca orchestration worker-start --spec x --agent claude --json", json),
      bash("orca orchestration worker-start --spec y --agent claude", "started dispatch ctx_23306fcdc6eb on run_9d46"),
      bash("orca orchestration worker-show --dispatch ctx_999999999999 --json", '{"result":{"dispatchId":"ctx_999999999999"}}'),
    ].join("\n");
    expect(backgroundLaunches(trace)).toEqual([
      { kind: "orca-worker", id: "ctx_0b5c88964b58", actor: "U1" },
      { kind: "orca-worker", id: "ctx_23306fcdc6eb", actor: "U1" },
    ]);
  });

  test("ids beyond what the call's own launchers printed are not taken as launches", () => {
    // The output is the whole command's: a task-list after the worker-start
    // lists other threads' workers, a cat prints an old launch's line.
    const list =
      '{"ok":true,"result":{"dispatchId":"ctx_a00000000001"}}\n{"ok":true,"result":{"tasks":[{"dispatchId":"ctx_b00000000002"},{"dispatchId":"ctx_c00000000003"}]}}';
    const trace = [
      bash("orca orchestration worker-start --spec x --json && orca orchestration task-list --json", list),
      bash("claude --bg x; cat /tmp/other-launch.out", "backgrounded · 11111111\nbackgrounded · 22222222"),
      bash("for i in 1 2 3; do claude --bg x$i; done", "backgrounded · 33333333\nbackgrounded · 44444444\nbackgrounded · 55555555"),
    ].join("\n");
    expect(backgroundLaunches(trace)).toEqual([]);
  });

  test("as many ids as launchers count, and one id printed twice is one", () => {
    const trace = [
      bash("claude --bg a && claude --bg b", "backgrounded · 11111111\nbackgrounded · 22222222"),
      bash(
        "orca orchestration worker-start --spec x --json",
        '{"ok":true,"result":{"dispatchId":"ctx_a00000000001","next":"dispatch ctx_a00000000001 started"}}',
      ),
    ].join("\n");
    expect(backgroundLaunches(trace).map((l) => l.id)).toEqual(["11111111", "22222222", "ctx_a00000000001"]);
  });

  test("a worker in an adopted terminal or on another Orca server is never ours to close", () => {
    const json = (id: string) => `{"ok":true,"result":{"dispatchId":"${id}"}}`;
    const trace = [
      bash("orca orchestration worker-start --spec x --terminal term_abc --json", json("ctx_a00000000001")),
      bash("orca orchestration worker-start --spec x --agent claude --on mini --json", json("ctx_a00000000002")),
      bash("orca orchestration worker-start --spec x --environment=box --json", json("ctx_a00000000003")),
      bash("orca orchestration worker-start --spec x --pairing-code 'orca://pair?x' --json", json("ctx_a00000000004")),
    ].join("\n");
    expect(backgroundLaunches(trace)).toEqual([]);
  });

  test("each launch once, junk lines skipped", () => {
    const trace = ["not json", bash("claude --bg x", BG_OUT), bash("claude --bg --resume cfaf8d7a-x", BG_OUT), ""].join("\n");
    expect(backgroundLaunches(trace)).toHaveLength(1);
  });
});

describe("liveClaudeSessions", () => {
  const agents = parseAgentsList(
    JSON.stringify([
      { id: "aaaaaaaa", kind: "background", state: "working" },
      { id: "bbbbbbbb", kind: "background", state: "done" },
      // Same id as one we launched but interactive: a person's session, never ours.
      { id: "cccccccc", kind: "interactive", status: "busy" },
      { id: "dddddddd", kind: "background", state: "blocked" },
      { pid: 1, kind: "interactive", sessionId: "x" },
    ]),
  ) ?? [];

  test("running background sessions the thread launched, nothing else", () => {
    expect(liveClaudeSessions(["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd"], agents)).toEqual(["aaaaaaaa", "dddddddd"]);
    expect(liveClaudeSessions(["eeeeeeee"], agents)).toEqual([]);
  });

  test("a list that is not JSON is a failed check, not an empty list", () => {
    expect(parseAgentsList("No sessions")).toBeUndefined();
    expect(parseAgentsList('{"error":"x"}')).toBeUndefined();
    expect(parseAgentsList("[]")).toEqual([]);
  });
});

describe("orcaWorkerLiveness", () => {
  test("settled, exited, finished or unknown to Orca is gone", () => {
    expect(orcaWorkerLiveness('{"ok":true,"result":{"state":"succeeded","stage":"settled","liveness":"exited"}}')).toBe("gone");
    expect(orcaWorkerLiveness('{"ok":true,"result":{"state":"failed"}}')).toBe("gone");
    expect(
      orcaWorkerLiveness('{"ok":false,"error":{"code":"dispatch_not_found","message":"Worker Dispatch ctx_0 was not found."}}'),
    ).toBe("gone");
  });
  test("a dispatched worker still running is live", () => {
    expect(orcaWorkerLiveness('{"ok":true,"result":{"state":"dispatched","stage":"running","liveness":"alive"}}')).toBe("live");
    expect(orcaWorkerLiveness('{"ok":true,"result":{"state":"ready","stage":"input_accepted","liveness":"live"}}')).toBe("live");
  });
  test("anything else is unknown, never gone", () => {
    expect(orcaWorkerLiveness('{"ok":false}')).toBe("unknown");
    expect(orcaWorkerLiveness('{"ok":false,"error":{"code":"runtime_unavailable"}}')).toBe("unknown");
    expect(orcaWorkerLiveness("boom")).toBe("unknown");
    expect(orcaWorkerLiveness("")).toBe("unknown");
  });
});

describe("mayStopLaunch", () => {
  test("your own, or anyone's for an admin", () => {
    const launch = { kind: "claude-bg" as const, id: "a", actor: "U1" };
    expect(mayStopLaunch(launch, "U1", false)).toBe(true);
    expect(mayStopLaunch(launch, "U2", false)).toBe(false);
    expect(mayStopLaunch(launch, "U2", true)).toBe(true);
    expect(mayStopLaunch({ kind: "claude-bg", id: "a" }, "U2", false)).toBe(false);
  });
});

describe("stopReply", () => {
  const bg = { kind: "claude-bg" as const, id: "cfaf8d7a", actor: "U1" };
  const worker = { kind: "orca-worker" as const, id: "ctx_1", actor: "U1" };

  test("names what it stopped beside the turn", () => {
    expect(stopReply("⏹ stopped *the long one* after 3m", { ...NOTHING_IN_BACKGROUND, stopped: [bg] })).toBe(
      "⏹ stopped *the long one* after 3m, and 1 background agent it started (`cfaf8d7a`)",
    );
  });

  test("background only, when no turn was running", () => {
    expect(stopReply(undefined, { ...NOTHING_IN_BACKGROUND, stopped: [bg, worker] })).toBe(
      "⏹ stopped 1 background agent and 1 Orca worker this thread started (`cfaf8d7a`, `ctx_1`)",
    );
  });

  test("says what it could not stop and what it left alone", () => {
    const out = stopReply(undefined, {
      stopped: [],
      failed: [{ ...bg, reason: "No job matching" }],
      notYours: [{ ...worker, actor: "U9" }],
      unchecked: [],
    });
    expect(out).toContain("could not stop 1 background agent: `cfaf8d7a` (No job matching)");
    expect(out).toContain("left 1 Orca worker running that belong to <@U9>");
  });

  test("a turn notice that is a whole sentence keeps it, the agents on their own line", () => {
    expect(stopReply("that one finished on its own just now.", { ...NOTHING_IN_BACKGROUND, stopped: [bg] })).toBe(
      "that one finished on its own just now.\n⏹ also stopped 1 background agent this thread started (`cfaf8d7a`)",
    );
  });

  test("a check that failed says so instead of nothing", () => {
    const out = stopReply(undefined, { ...NOTHING_IN_BACKGROUND, unchecked: [{ ...bg, reason: "`claude agents` failed: timeout" }] });
    expect(out).toBe(
      "could not check whether 1 background agent this thread started is still running, so I left it: `cfaf8d7a` (`claude agents` failed: timeout)",
    );
  });

  test("nothing at all is undefined, so the caller keeps its own words", () => {
    expect(stopReply(undefined, NOTHING_IN_BACKGROUND)).toBeUndefined();
    expect(describeBackground([bg, { ...bg, id: "x" }])).toBe("2 background agents");
  });
});
