import { describe, expect, test } from "bun:test";
import {
  createRunRegistry,
  decideRunPress,
  DROP_ACTION,
  STOP_ACTION,
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

describe("decideRunPress", () => {
  const press = (over: Partial<Parameters<typeof decideRunPress>[1]> = {}) => ({
    actionId: STOP_ACTION,
    value: "r1",
    by: "U1",
    isAdmin: false,
    ...over,
  });

  test("stopping your own running turn", () => {
    const runs = createRunRegistry();
    runs.track(run()).running();
    const out = decideRunPress(runs, press());
    expect(out.kind).toBe("stopped");
  });

  test("dropping one that had not started yet", () => {
    const runs = createRunRegistry();
    runs.track(run()); // queued, never ran
    const out = decideRunPress(runs, press({ actionId: DROP_ACTION }));
    expect(out.kind).toBe("dropped");
  });

  test("someone else's turn takes an admin - it is their work and their money", () => {
    const runs = createRunRegistry();
    const t = runs.track(run({ actor: "U-other" }));
    t.running();

    expect(decideRunPress(runs, press({ by: "U1" })).kind).toBe("refused");
    expect(t.signal.aborted).toBe(false); // refused means untouched

    expect(decideRunPress(runs, press({ by: "U1", isAdmin: true })).kind).toBe("stopped");
    expect(t.signal.aborted).toBe(true);
  });

  test("a button that outlived its run says so instead of failing", () => {
    // it sat in the channel while the work finished on its own, which is fine
    const runs = createRunRegistry();
    expect(decideRunPress(runs, press()).kind).toBe("gone");
  });

  test("another button's press is not ours to act on", () => {
    const runs = createRunRegistry();
    runs.track(run()).running();
    expect(decideRunPress(runs, press({ actionId: "command_approve" })).kind).toBe("ignored");
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

    const first = decideRunPress(runs, { actionId: STOP_ACTION, value: "r1", by: "U1", isAdmin: false });
    expect(first.kind).toBe("stopped");

    // the process may take a moment to die, or never die at all. Reporting a
    // fresh successful stop each time is how four presses produced four
    // confident "stopped" lines while nothing was actually dying.
    const second = decideRunPress(runs, { actionId: STOP_ACTION, value: "r1", by: "U1", isAdmin: false });
    expect(second.kind).toBe("stopping");
  });

  test("a stopped run records when it was asked, so the wait can be reported", () => {
    const runs = createRunRegistry(() => 7000);
    track(runs, "r2");
    decideRunPress(runs, { actionId: STOP_ACTION, value: "r2", by: "U1", isAdmin: false });

    expect(runs.byId("r2")?.state).toBe("stopping");
    expect(runs.byId("r2")?.stoppedAt).toBe(7000);
  });

  test("it is still gone once the turn actually unwinds", () => {
    const runs = createRunRegistry(() => 0);
    const h = track(runs, "r3");
    decideRunPress(runs, { actionId: STOP_ACTION, value: "r3", by: "U1", isAdmin: false });
    h.done();

    expect(decideRunPress(runs, { actionId: STOP_ACTION, value: "r3", by: "U1", isAdmin: false }).kind).toBe("gone");
  });
});
