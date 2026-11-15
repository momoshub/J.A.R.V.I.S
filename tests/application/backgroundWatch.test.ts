import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createBackgroundJobRepo, type BackgroundJobRepo } from "../../src/infrastructure/db/backgroundJobRepo.ts";
import { createBackgroundWatch } from "../../src/application/backgroundWatch.ts";

const thread = { channelId: "D1", threadTs: "1.1", slackUserId: "U1" };

let jobs: BackgroundJobRepo;
let now: number;
let said: { channel: string; text: string; thread: string }[];
let turns: { text: string; slackUserId: string; keepSession?: boolean; unprompted?: boolean }[];

const build = (over: { mayRun?: (id: string) => boolean; failTurn?: boolean } = {}) =>
  createBackgroundWatch({
    jobs,
    clock: () => now,
    say: async (channel, text, t) => void said.push({ channel, text, thread: t }),
    runTurn: async (r) => {
      if (over.failTurn) throw new Error("queue down");
      turns.push(r);
    },
    mayRun: over.mayRun,
  });

beforeEach(() => {
  jobs = createBackgroundJobRepo(openDatabase(":memory:"));
  now = 1_000_000;
  said = [];
  turns = [];
});

describe("background watch", () => {
  test("a cut-off says so in the thread at once and hands the thread a turn", async () => {
    const w = build();
    w.track(thread, ["Write the blog post"]);
    expect(await w.cutOff(thread, ["Write the blog post"])).toBe(true);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ channel: "D1", thread: "1.1" });
    expect(said[0]?.text).toContain("`Write the blog post`");
    expect(said[0]?.text).toContain("not done");
    expect(said[0]?.text).toContain("new turn");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ slackUserId: "U1", keepSession: true, unprompted: true });
    expect(turns[0]?.text).toContain("NOT done");
    expect(turns[0]?.text).toContain("Orca worker");
    expect(jobs.list()).toEqual([]);
  });

  test("work that died with the process is reported on the next boot, once", async () => {
    const before = build();
    before.track(thread, ["a", "b"]);
    const after = build();
    expect(await after.recover()).toBe(1);
    expect(said[0]?.text).toContain("restarted");
    expect(said[0]?.text).toContain("2 background jobs");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toContain("restarted");
    // A second boot (or a racing path) finds nothing left to report.
    expect(await build().recover()).toBe(0);
    expect(said).toHaveLength(1);
  });

  test("a death one path reported is never reported by the other", async () => {
    const w = build();
    w.track(thread, ["job"]);
    await w.cutOff(thread, ["job"]);
    expect(await w.recover()).toBe(0);
    expect(said).toHaveLength(1);
    expect(turns).toHaveLength(1);
  });

  test("a clean finish clears the list and reports nothing", async () => {
    const w = build();
    w.track(thread, ["job"]);
    w.track(thread, []);
    expect(await w.recover()).toBe(0);
    expect(await w.cutOff(thread, [])).toBe(false);
    expect(said).toEqual([]);
    expect(turns).toEqual([]);
  });

  test("a person no longer allowed is told but gets no turn", async () => {
    const w = build({ mayRun: () => false });
    w.track(thread, ["job"]);
    await w.cutOff(thread, ["job"]);
    expect(said[0]?.text).toContain("ask me to pick it up again");
    expect(turns).toEqual([]);
  });

  test("a thread is handed back twice an hour, then only told", async () => {
    const w = build();
    for (let i = 0; i < 3; i++) {
      w.track(thread, ["job"]);
      await w.cutOff(thread, ["job"]);
    }
    expect(said).toHaveLength(3);
    expect(turns).toHaveLength(2);
    expect(said[2]?.text).toContain("ask me to pick it up again");
    now += 61 * 60_000;
    w.track(thread, ["job"]);
    await w.cutOff(thread, ["job"]);
    expect(turns).toHaveLength(3);
  });

  test("a hand-back that cannot start does not lose the notice", async () => {
    const w = build({ failTurn: true });
    w.track(thread, ["job"]);
    await w.cutOff(thread, ["job"]);
    await Promise.resolve();
    expect(said).toHaveLength(1);
  });

  test("a cut-off with no row says nothing: the row decides, not the argument", async () => {
    const w = build();
    expect(await w.cutOff(thread, ["job"])).toBe(false);
    expect(said).toEqual([]);
    expect(turns).toEqual([]);
  });

  test("live work in this process is never reported as lost by recovery, nor twice", async () => {
    const w = build();
    w.track(thread, ["live agent"]);
    expect(await w.recover()).toBe(0);
    expect(await w.cutOff(thread, ["live agent"])).toBe(true);
    expect(said).toHaveLength(1);
    expect(said[0]?.text).not.toContain("restarted");
    expect(turns).toHaveLength(1);
  });

  test("a turn that clears the thread between boot and recovery does not lose the death", async () => {
    build().track(thread, ["dead agent"]);
    const after = build();
    // the redelivered turn finished inside the delay and cleared the thread
    after.track(thread, []);
    expect(await after.recover()).toBe(1);
    expect(said).toHaveLength(1);
    expect(said[0]?.text).toContain("`dead agent`");
    expect(said[0]?.text).toContain("restarted");
    // that turn is already in the thread, so no second one is started
    expect(turns).toEqual([]);
    expect(said[0]?.text).toContain("already has a turn");
  });

  test("a turn that tracks new work between boot and recovery: the old work is told once, the new work once", async () => {
    build().track(thread, ["dead agent"]);
    const after = build();
    after.track(thread, ["new agent"]);
    expect(await after.recover()).toBe(1);
    expect(said[0]?.text).toContain("`dead agent`");
    expect(said[0]?.text).not.toContain("new agent");
    expect(await after.cutOff(thread, ["new agent"])).toBe(true);
    expect(said).toHaveLength(2);
    expect(said[1]?.text).toContain("`new agent`");
    expect(said[1]?.text).not.toContain("restarted");
    expect(await after.cutOff(thread, ["new agent"])).toBe(false);
    expect(said).toHaveLength(2);
  });

  test("the leftovers are taken at boot, not when recovery runs", async () => {
    build().track(thread, ["dead agent"]);
    build();
    expect(jobs.list()).toEqual([]);
  });

  test("a thread nothing touched since boot is told and handed a turn", async () => {
    build().track(thread, ["dead agent"]);
    expect(await build().recover()).toBe(1);
    expect(turns).toHaveLength(1);
  });
});
