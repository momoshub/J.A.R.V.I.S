import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createWatchRepo, type WatchRepo } from "../../src/infrastructure/db/watchRepo.ts";
import {
  cancelWatchesOnWorkerStop,
  cancelWorkerWatches,
  createWatcher,
  type CheckResult,
} from "../../src/application/watcher.ts";
import { MAX_CONSECUTIVE_ERRORS, MAX_DEADLINE_MS } from "../../src/domain/watch.ts";

let db: DbClient;
let watches: WatchRepo;
let now: number;
let turns: { threadTs: string; text: string; slackUserId: string; keepSession?: boolean; unprompted?: boolean }[];
let said: string[];

const EVERY = 60_000;

const build = (check: (cmd: string) => Promise<CheckResult>) => {
  turns = [];
  said = [];
  return createWatcher({
    watches,
    clock: () => now,
    check: async (cmd) => check(cmd),
    runTurn: async (r) =>
      void turns.push({
        threadTs: r.threadTs,
        text: r.text,
        slackUserId: r.slackUserId,
        keepSession: r.keepSession,
        unprompted: r.unprompted,
      }),
    say: async (_c, text) => void said.push(text),
  });
};

const add = (over: Partial<Parameters<WatchRepo["add"]>[0]> = {}) =>
  watches.add(
    {
      channelId: "C1",
      threadTs: "9.9",
      slackUserId: "U7",
      note: "promote be US then SG",
      check: "gh run view 1 | grep -q completed",
      everyMs: EVERY,
      deadlineAt: now + 10 * EVERY,
      createdAt: now,
      ...over,
    },
    now,
  );

beforeEach(() => {
  db = openDatabase(":memory:");
  watches = createWatchRepo(db);
  now = 1_000_000;
});

describe("watcher", () => {
  test("nothing is checked before its first interval is up", async () => {
    add();
    let calls = 0;
    const w = build(async () => ((calls += 1), { code: 1, output: "" }));
    await w.tick();
    expect(calls).toBe(0); // the thing it watches has only just started
  });

  test("a setter who is no longer allowed has the predicate never run, and the watch ends with a line", async () => {
    add();
    let calls = 0;
    turns = [];
    said = [];
    const w = createWatcher({
      watches,
      clock: () => now,
      check: async () => ((calls += 1), { code: 0, output: "" }),
      runTurn: async (r) => void turns.push({ threadTs: r.threadTs, text: r.text, slackUserId: r.slackUserId }),
      say: async (_c, text) => void said.push(text),
      mayRun: (id) => id !== "U7",
    });
    now += EVERY;
    await w.tick();
    expect(calls).toBe(0);
    expect(turns).toHaveLength(0);
    expect(said).toEqual(["Stopped waiting: whoever set this watch is no longer allowed to run it."]);
    expect(watches.waiting()).toHaveLength(0);
  });

  test("not ready yet means ask again later, and no turn", async () => {
    add();
    const w = build(async () => ({ code: 1, output: "in_progress" }));
    now += EVERY;
    await w.tick();
    expect(turns).toHaveLength(0);
    expect(watches.waiting()[0]?.attempts).toBe(1);
  });

  test("ready hands the thread a turn that carries on", async () => {
    const created = add();
    const w = build(async () => ({ code: 0, output: "status\ncompleted" }));
    now += EVERY * 3;
    await w.tick();

    expect(turns).toHaveLength(1);
    expect(turns[0]?.threadTs).toBe("9.9");
    expect(turns[0]?.slackUserId).toBe("U7"); // as whoever was waiting
    expect(turns[0]?.text).toContain("promote be US then SG");
    expect(turns[0]?.text).toContain("do not start it over");
    expect(turns[0]?.text).toContain("completed");
    expect(watches.get(created.id)?.state).toBe("fired");
  });

  test("a fired watch hands what it printed to onFired, and a throw there does not stop the hand-back", async () => {
    add();
    const seen: string[] = [];
    const w = createWatcher({
      watches,
      clock: () => now,
      check: async () => ({ code: 0, output: "orca worker ctx_a finished: done" }),
      runTurn: async (r) => void turns.push({ threadTs: r.threadTs, text: r.text, slackUserId: r.slackUserId }),
      onFired: (watch, out) => {
        seen.push(`${watch.note}|${out}`);
        throw new Error("db locked");
      },
    });
    turns = [];
    now += EVERY;
    await w.tick();
    expect(seen).toEqual(["promote be US then SG|orca worker ctx_a finished: done"]);
    expect(turns).toHaveLength(1);
  });

  test("it fires once, not once per tick", async () => {
    add();
    const w = build(async () => ({ code: 0, output: "" }));
    now += EVERY;
    await w.tick();
    now += EVERY;
    await w.tick();
    expect(turns).toHaveLength(1);
  });

  test("running out of time says so, and says nothing was done", async () => {
    const created = add({ deadlineAt: now + EVERY });
    const w = build(async () => ({ code: 1, output: "" }));
    now += EVERY * 2;
    await w.tick();
    expect(turns[0]?.text).toContain("I have not done it");
    expect(watches.get(created.id)?.state).toBe("expired");
  });

  test("a watch that ran its full 30 days is closed with one last line and nothing re-arms it", async () => {
    const created = add({ deadlineAt: now + MAX_DEADLINE_MS, everyMs: 6 * 3_600_000 });
    const w = build(async () => ({ code: 1, output: "" }));
    // a month of polling by tick, never a timer sized by the deadline
    while (now < created.deadlineAt) {
      now += 6 * 3_600_000;
      await w.tick();
    }
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toContain(`watch #${created.id} ran its full 30 days with nothing happening, closed`);
    expect(turns[0]?.text).toContain("Do NOT set a new watch");
    expect(watches.get(created.id)?.state).toBe("expired");
    expect(watches.waiting()).toHaveLength(0);
    now += MAX_DEADLINE_MS;
    await w.tick();
    expect(turns).toHaveLength(1);
  });

  test("a check that will not run gives up eventually, rather than retrying forever", async () => {
    const created = add();
    const w = build(async () => ({ code: 0, output: "", error: "command not found: gh" }));
    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS; i++) {
      now += EVERY;
      await w.tick();
    }
    expect(watches.get(created.id)?.state).toBe("failed");
    expect(turns[0]?.text).toContain("kept failing to run");
  });

  test("a check that errors once and then works is not held against it", async () => {
    add();
    let first = true;
    const w = build(async () =>
      first ? ((first = false), { code: 0, output: "", error: "flaky" }) : { code: 0, output: "ok" },
    );
    now += EVERY;
    await w.tick();
    expect(watches.waiting()[0]?.errors).toBe(1);
    now += EVERY;
    await w.tick();
    expect(turns).toHaveLength(1);
  });

  test("a watch with no predicate is a plain timer", async () => {
    const created = add({ check: "", deadlineAt: now + EVERY * 2 });
    const w = build(async () => {
      throw new Error("should never run a check");
    });
    now += EVERY;
    await w.tick();
    expect(turns).toHaveLength(0);
    now += EVERY;
    await w.tick();
    expect(turns).toHaveLength(1);
    expect(watches.get(created.id)?.state).toBe("fired");
  });

  test("one broken watch does not stop the others", async () => {
    add({ threadTs: "1.1" });
    add({ threadTs: "2.2" });
    let n = 0;
    const w = build(async () => {
      n += 1;
      if (n === 1) throw new Error("boom");
      return { code: 0, output: "" };
    });
    now += EVERY;
    await w.tick();
    expect(turns.map((t) => t.threadTs)).toEqual(["2.2"]);
  });

  test("a failed follow-up turn is reported in the thread, not swallowed", async () => {
    add();
    const w = createWatcher({
      watches,
      clock: () => now,
      check: async () => ({ code: 0, output: "" }),
      runTurn: async () => {
        throw new Error("brain is down");
      },
      say: async (_c, text) => void (said ??= []).push(text),
    });
    said = [];
    now += EVERY;
    await w.tick();
    await Bun.sleep(0); // the turn is not awaited by the tick, its failure lands just after
    expect(said[0]).toContain("could not pick the thread back up");
  });
  test("a hand-back that never ends does not hold the other watches", async () => {
    // #190 fired a turn that ran for half an hour; the tick awaited it, so #191
    // and every other due watch sat unchecked the whole time.
    add({ threadTs: "1.1", check: "first" });
    add({ threadTs: "2.2", check: "second" });
    const started: string[] = [];
    const checked: string[] = [];
    const w = createWatcher({
      watches,
      clock: () => now,
      check: async (cmd) => (checked.push(cmd), { code: cmd === "first" ? 0 : 1, output: "" }),
      runTurn: (r) => (started.push(r.threadTs), new Promise<void>(() => {})),
    });
    now += EVERY;
    await w.tick();
    expect(started).toEqual(["1.1"]);
    expect(checked).toEqual(["first", "second"]);
    now += EVERY;
    await w.tick(); // a second tick is not locked out by the turn still running
    expect(checked).toEqual(["first", "second", "second"]);
    expect(started).toEqual(["1.1"]); // and the fired one is not fired again
  });
  test("a hand-back resumes the session that set the watch, rules changed or not", async () => {
    add({ check: "true" });
    now += EVERY;
    const w = build(async () => ({ code: 0, output: "" }));
    await w.tick();
    expect(turns[0]?.keepSession).toBe(true);
  });
  test("a hand-back is marked as nobody's message, so it is not read as a person's request", async () => {
    add({ check: "true" });
    now += EVERY;
    const w = build(async () => ({ code: 0, output: "" }));
    await w.tick();
    expect(turns[0]?.unprompted).toBe(true);
  });
});

describe("watcher, when the database itself fails", () => {
  // `git stash` on the committed data/jarvis.db swapped the file under the open
  // handle. The tick threw from a bare timer, and the unhandled rejection
  // killed the bot mid-turn.
  test("a failed read of due watches is handed over, not thrown", async () => {
    const swapped = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR_VNODE" });
    const errors: unknown[] = [];
    const w = createWatcher({
      watches: { ...watches, due: () => { throw swapped; } },
      clock: () => now,
      check: async () => ({ code: 0, output: "" }),
      runTurn: async () => {},
      onError: (e) => void errors.push(e),
    });
    await expect(w.tick()).resolves.toBeUndefined();
    expect(errors).toEqual([swapped]);
  });
});

describe("watcher: CI gate rows", () => {
  const gateCheck = 'ci-gate:{"url":"https://github.com/o/r/pull/1","policy":"approve-after"}';

  test("a gate row is stepped by the gate, never run as shell, and hands back no turn", async () => {
    add({ check: gateCheck, note: "CI gate" });
    turns = [];
    let shell = 0;
    const steps: string[] = [];
    const w = createWatcher({
      watches,
      clock: () => now,
      check: async () => ((shell += 1), { code: 0, output: "" }),
      runTurn: async (r) => void turns.push({ ...r }),
      gate: {
        step: async (spec) => (steps.push(spec.url), steps.length < 2 ? "pending" : "done"),
        stop: async () => {},
      },
    });
    now += EVERY;
    await w.tick();
    expect(watches.waiting()).toHaveLength(1);
    now += EVERY;
    await w.tick();
    expect(steps).toHaveLength(2);
    expect(shell).toBe(0);
    expect(turns).toEqual([]);
    expect(watches.waiting()).toHaveLength(0);
    expect(watches.get(1)?.state).toBe("fired");
  });

  test("past its deadline the gate is told why, and the row expires", async () => {
    add({ check: gateCheck, deadlineAt: now + 2 * EVERY });
    const stopped: string[] = [];
    const w = createWatcher({
      watches,
      clock: () => now,
      check: async () => ({ code: 0, output: "" }),
      runTurn: async () => {},
      gate: { step: async () => "pending", stop: async (_s, _w, why) => void stopped.push(why) },
    });
    now += EVERY;
    await w.tick();
    expect(stopped).toEqual([]);
    now += EVERY;
    await w.tick();
    expect(stopped).toEqual(["deadline"]);
    expect(watches.get(1)?.state).toBe("expired");
  });

  test("a gate that keeps throwing is given up on after the same streak as any check", async () => {
    add({ check: gateCheck, deadlineAt: now + 100 * EVERY });
    const stopped: string[] = [];
    const w = createWatcher({
      watches,
      clock: () => now,
      check: async () => ({ code: 0, output: "" }),
      runTurn: async () => {},
      gate: {
        step: async () => {
          throw new Error("gh is down");
        },
        stop: async (_s, _w, why) => void stopped.push(why),
      },
    });
    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS; i++) {
      now += EVERY;
      await w.tick();
    }
    expect(stopped).toEqual(["errors"]);
    expect(watches.get(1)?.state).toBe("failed");
  });

  test("with no gate wired the row is settled failed, not run as a shell command", async () => {
    add({ check: gateCheck });
    let shell = 0;
    const w = createWatcher({
      watches,
      clock: () => now,
      check: async () => ((shell += 1), { code: 0, output: "" }),
      runTurn: async () => {},
    });
    now += EVERY;
    await w.tick();
    expect(shell).toBe(0);
    expect(watches.get(1)?.state).toBe("failed");
  });

  test("a worker found dead is told to the thread at once, then handed back once", async () => {
    add({ check: "bun orca-worker-wait.ts ctx_abc123" });
    const w = build(async () => ({ code: 0, output: "orca worker ctx_abc123 died: stopped without worker_done" }));
    now += EVERY;
    await w.tick();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("Orca worker ctx_abc123 died");
    expect(said[0]).toContain("not done");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toContain("DIED");
    // The watch is settled: a second tick neither says nor hands back again.
    now += EVERY;
    await w.tick();
    expect(said).toHaveLength(1);
    expect(turns).toHaveLength(1);
  });

  test("the watch is settled before the death line is posted, so an exit in between cannot refire it", async () => {
    add({ check: "bun orca-worker-wait.ts ctx_abc123" });
    let stateWhenSaid: string | undefined;
    const w = createWatcher({
      watches,
      clock: () => now,
      check: async () => ({ code: 0, output: "orca worker ctx_abc123 died: stopped without worker_done" }),
      runTurn: async () => {},
      say: async () => {
        stateWhenSaid = watches.get(1)?.state;
      },
    });
    now += EVERY;
    await w.tick();
    expect(stateWhenSaid).toBe("fired");
  });

  test("a worker that finished or waits is not announced as dead", async () => {
    add({ check: "bun orca-worker-wait.ts ctx_abc123" });
    const w = build(async () => ({ code: 0, output: "orca worker ctx_abc123 finished: completed" }));
    now += EVERY;
    await w.tick();
    expect(said).toEqual([]);
    expect(turns).toHaveLength(1);
  });

  test("a watch cancelled while its check ran says nothing and hands nothing back", async () => {
    const w0 = add({ check: "'bun' '/x/bin/orca-worker-wait.ts' 'ctx_dead1'" });
    const w = build(async () => {
      // the bot stops the worker (and cancels its watch) mid-check
      watches.cancel(w0.id, now);
      return { code: 0, output: "orca worker ctx_dead1 died: stopped without reporting, task left blocked" };
    });
    now += EVERY;
    await w.tick();
    expect(said).toEqual([]);
    expect(turns).toEqual([]);
    expect(watches.get(w0.id)?.state).toBe("cancelled");
  });

  test("cancelWorkerWatches ends only the watches on that dispatch", () => {
    const a = add({ check: "'bun' '/x/bin/orca-worker-wait.ts' 'ctx_abc'" });
    const b = add({ check: "'bun' '/x/bin/orca-worker-wait.ts' 'ctx_abc' '--past-wait=5'", threadTs: "1.1" });
    const c = add({ check: "'bun' '/x/bin/orca-worker-wait.ts' 'ctx_abcd'" });
    const d = add({ check: "echo ctx_abc" });
    expect(cancelWorkerWatches(watches, "ctx_abc", now).sort()).toEqual([a.id, b.id].sort());
    expect(watches.waiting().map((w) => w.id).sort()).toEqual([c.id, d.id].sort());
  });

  test("a turn's worker-stop command cancels that worker's watch, and nothing else", () => {
    const a = add({ check: "'bun' '/x/bin/orca-worker-wait.ts' 'ctx_5b5fa1aae471'" });
    const b = add({ check: "'bun' '/x/bin/orca-worker-wait.ts' 'ctx_other'" });
    const seen = cancelWatchesOnWorkerStop(watches, () => now);
    seen("orca orchestration worker-show --dispatch ctx_other --json");
    seen("orca orchestration worker-stop --dispatch ctx_5b5fa1aae471 --json");
    expect(watches.get(a.id)?.state).toBe("cancelled");
    expect(watches.get(b.id)?.state).toBe("waiting");
  });

  test("a worker that dies on its own still gets the heads-up and the hand-back", async () => {
    add({ check: "'bun' '/x/bin/orca-worker-wait.ts' 'ctx_crash'" });
    const w = build(async () => ({ code: 0, output: "orca worker ctx_crash died: liveness dead, no outcome" }));
    now += EVERY;
    await w.tick();
    expect(said[0]).toContain("died without reporting");
    expect(turns).toHaveLength(1);
  });
});
