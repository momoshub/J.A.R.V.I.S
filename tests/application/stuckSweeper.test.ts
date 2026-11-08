import { describe, expect, test } from "bun:test";
import { createStuckSweeper } from "../../src/application/stuckSweeper.ts";
import { REPEAT_AFTER_MS, type StuckWork } from "../../src/domain/stuckWork.ts";

const work: StuckWork = {
  tasks: [{ taskId: "task_1", runId: "run_a", title: "t", why: "worker exited", owner: { channelId: "C1", threadTs: "1.2" } }],
  prs: [],
  problems: [],
};

const setup = (opts: { scan?: () => Promise<StuckWork>; postOk?: boolean } = {}) => {
  let now = 1_000_000;
  const store = new Map<string, string>();
  const dms: { user: string; text: string }[] = [];
  const sweeper = createStuckSweeper({
    clock: () => now,
    scan: opts.scan ?? (async () => work),
    settings: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
    seenKey: "seen",
    ownerSlackId: "UOWNER",
    postDm: async (user, text) => {
      dms.push({ user, text });
      return opts.postOk === false ? undefined : { ts: "1" };
    },
    team: async () => "acme",
    prefix: "X/jv",
  });
  return { sweeper, dms, store, advance: (ms: number) => void (now += ms) };
};

describe("stuck sweeper", () => {
  test("DMs the owner once, then not again within the window, then again after it", async () => {
    const { sweeper, dms, advance } = setup();
    await sweeper.tick();
    expect(dms).toHaveLength(1);
    expect(dms[0]?.user).toBe("UOWNER");
    expect(dms[0]?.text).toContain("acme.slack.com/archives/C1/p12");
    advance(15 * 60_000);
    await sweeper.tick();
    expect(dms).toHaveLength(1);
    advance(REPEAT_AFTER_MS);
    await sweeper.tick();
    expect(dms).toHaveLength(2);
  });

  test("the record survives a restart: a new sweeper on the same settings stays quiet", async () => {
    const first = setup();
    await first.sweeper.tick();
    const again = createStuckSweeper({
      clock: () => 1_000_000 + 60_000,
      scan: async () => work,
      settings: { get: (k) => first.store.get(k), set: (k, v) => void first.store.set(k, v) },
      seenKey: "seen",
      ownerSlackId: "UOWNER",
      postDm: async () => {
        throw new Error("should not post");
      },
      prefix: "X/jv",
    });
    await again.tick();
    expect(first.dms).toHaveLength(1);
  });

  test("a DM that did not land is tried again next sweep", async () => {
    const { sweeper, dms, store } = setup({ postOk: false });
    await sweeper.tick();
    expect(store.get("seen")).toBeUndefined();
    await sweeper.tick();
    expect(dms).toHaveLength(2);
  });

  test("nothing stuck is no DM, and a failing scan never throws", async () => {
    const quiet = setup({ scan: async () => ({ tasks: [], prs: [], problems: [] }) });
    await quiet.sweeper.tick();
    expect(quiet.dms).toHaveLength(0);
    const broken = setup({ scan: async () => Promise.reject(new Error("boom")) });
    await broken.sweeper.tick();
    expect(broken.dms).toHaveLength(0);
  });

  test("ticks never overlap", async () => {
    let release = () => {};
    let scans = 0;
    const { sweeper } = setup({
      scan: () => {
        scans++;
        return new Promise<StuckWork>((r) => (release = () => r(work)));
      },
    });
    const a = sweeper.tick();
    await sweeper.tick();
    release();
    await a;
    expect(scans).toBe(1);
  });
});
