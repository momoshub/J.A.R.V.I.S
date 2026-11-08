import { describe, expect, test } from "bun:test";
import {
  createRunRegistry,
  cutForRestart,
  holdThreads,
  RESTART_STOPPER,
} from "../../src/application/runRegistry.ts";

const run = (over: Partial<Parameters<ReturnType<typeof createRunRegistry>["track"]>[0]> = {}) => ({
  id: "r1",
  key: "C1:100.1",
  channelId: "C1",
  threadTs: "100.1",
  actor: "U1",
  what: "check the migration",
  startedAt: 1_000,
  ...over,
});

describe("createRunRegistry", () => {
  test("a tracked turn can be stopped, and the signal is what ends it", () => {
    const runs = createRunRegistry();
    const t = runs.track(run());
    t.running();

    expect(t.signal.aborted).toBe(false);
    expect(runs.current("C1:100.1")?.what).toBe("check the migration");

    const stopped = runs.stop("r1", "U9");
    expect(stopped?.stoppedBy).toBe("U9");
    expect(t.signal.aborted).toBe(true); // the CLI adapter kills the child on this
  });

  test("a turn still waiting its turn is distinguishable from one that is running", () => {
    const runs = createRunRegistry();
    const t = runs.track(run());
    // queued: nothing has spawned yet, so stopping it costs nothing
    expect(runs.current("C1:100.1")).toBeUndefined();
    expect(runs.inThread("C1:100.1")).toHaveLength(1);

    t.running();
    expect(runs.current("C1:100.1")?.id).toBe("r1");
  });

  test("a finished turn is forgotten, so its button can only say so", () => {
    const runs = createRunRegistry();
    const t = runs.track(run());
    t.running();
    t.done();
    expect(runs.byId("r1")).toBeUndefined();
    expect(runs.current("C1:100.1")).toBeUndefined();
    expect(runs.stop("r1", "U1")).toBeUndefined();
  });

  test("threads do not stop each other's work", () => {
    const runs = createRunRegistry();
    const a = runs.track(run({ id: "a", key: "C1:1" }));
    const b = runs.track(run({ id: "b", key: "C1:2" }));
    a.running();
    b.running();

    runs.stopThread("C1:1", "U1");
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
  });
});


describe("stopping is a request, not an event", () => {
  const track = (runs: ReturnType<typeof createRunRegistry>, id: string, actor = "U1") => {
    const h = runs.track({ id, key: "C1:1", channelId: "C1", actor, what: "a long job", startedAt: 0 });
    h.running();
    return h;
  };

  test("the first stop is an action, the second is not", () => {
    const runs = createRunRegistry(() => 1000);
    track(runs, "r1");

    expect(runs.stop("r1", "U1")).toBeDefined();
    // the process may take a moment to die, or never die at all. Reporting a
    // fresh successful stop each time is how four presses produced four
    // confident "stopped" lines while nothing was actually dying.
    expect(runs.stop("r1", "U1")).toBeUndefined();
    expect(runs.byId("r1")?.state).toBe("stopping");
  });

  test("a stopped run records when it was asked, so the wait can be reported", () => {
    const runs = createRunRegistry(() => 7000);
    track(runs, "r2");
    runs.stop("r2", "U1");

    expect(runs.byId("r2")?.state).toBe("stopping");
    expect(runs.byId("r2")?.stoppedAt).toBe(7000);
  });

  test("asking twice does not stop it twice - the second ask gets nothing", () => {
    // the lie that made four presses read as four successful stops
    const runs = createRunRegistry(() => 0);
    track(runs, "r3");
    expect(runs.stop("r3", "U1")).toBeDefined();
    expect(runs.stop("r3", "U1")).toBeUndefined();
  });

  test("it is gone once the turn actually unwinds", () => {
    const runs = createRunRegistry(() => 0);
    const h = track(runs, "r4");
    h.done();
    expect(runs.stop("r4", "U1")).toBeUndefined();
  });
});

describe("cutting a turn that ran past its restart budget", () => {
  test("stops every turn its inbox row started, and only those", () => {
    const runs = createRunRegistry();
    const mine = runs.track(run({ id: "a", inboxRowId: 7 }));
    const queued = runs.track(run({ id: "b", inboxRowId: 7, threadTs: "100.1" }));
    const other = runs.track(run({ id: "c", inboxRowId: 8, key: "C1:200.1", threadTs: "200.1" }));
    mine.running();
    const cut = cutForRestart(runs, 7);
    expect(cut.map((r) => r.id)).toEqual(["a", "b"]);
    expect(cut[0]?.stoppedBy).toBe(RESTART_STOPPER);
    expect(mine.signal.aborted).toBe(true);
    expect(queued.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
  });

  test("nothing running for the row cuts nothing, so the row is left alone", () => {
    const runs = createRunRegistry();
    expect(cutForRestart(runs, 7)).toEqual([]);
    const t = runs.track(run({ inboxRowId: 7 }));
    t.done();
    expect(cutForRestart(runs, 7)).toEqual([]);
  });

  test("each thread is told once, in the thread even for a top-level message", () => {
    const runs = createRunRegistry();
    runs.track(run({ id: "a", inboxRowId: 7 }));
    runs.track(run({ id: "b", inboxRowId: 7 }));
    runs.track(run({ id: "c", inboxRowId: 7, key: "D1:300.1", channelId: "D1", threadTs: undefined, messageTs: "300.1" }));
    expect(holdThreads(cutForRestart(runs, 7))).toEqual([
      { channelId: "C1", threadTs: "100.1" },
      { channelId: "D1", threadTs: "300.1" },
    ]);
  });
});
