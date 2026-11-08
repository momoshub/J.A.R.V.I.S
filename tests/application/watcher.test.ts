import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createWatchRepo, type WatchRepo } from "../../src/infrastructure/db/watchRepo.ts";
import { createWatcher, type CheckResult } from "../../src/application/watcher.ts";
import { MAX_CONSECUTIVE_ERRORS } from "../../src/domain/watch.ts";

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
  test("a hand-back is marked as nobody's message, so it queues without a busy notice", async () => {
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
