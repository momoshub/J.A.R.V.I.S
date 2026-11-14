import { describe, expect, test } from "bun:test";
import { createStalePromiseSweep, type StalePromiseDeps } from "../../src/application/stalePromiseSweep.ts";
import type { EndedThread } from "../../src/infrastructure/db/messageRepo.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const PROMISE = "Next I will update the post.";
const ts = (agoMin: number): string => String((NOW - agoMin * MIN) / 1000);

type Reply = { ts: string; own: boolean; text: string };

const setup = (
  over: {
    threads?: EndedThread[];
    replies?: Record<string, Reply[]>;
    deps?: Partial<StalePromiseDeps>;
    store?: Map<string, string>;
  } = {},
) => {
  const store = over.store ?? new Map<string, string>();
  const turns: { channelId: string; threadTs: string; slackUserId: string; text: string; unprompted?: boolean }[] = [];
  const logs: string[] = [];
  const activity: string[] = [];
  const threads = over.threads ?? [{ channelId: "C1", threadTs: "100.1", lastAt: NOW - 45 * MIN, slackUserId: "U1" }];
  const replies = over.replies ?? { "C1:100.1": [{ ts: ts(45), own: true, text: PROMISE }] };
  let enabled = true;
  const sweep = createStalePromiseSweep({
    clock: () => NOW,
    enabled: () => enabled,
    threads: () => threads,
    replies: async (c, t) => replies[`${c}:${t}`] ?? [],
    turnRunning: () => false,
    workflowActive: () => false,
    watches: () => 0,
    reminders: () => 0,
    liveWorker: async () => false,
    mayRun: () => true,
    runTurn: async (req) => void turns.push(req),
    settings: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
    nudgedKey: "nudged",
    minAgeMs: 30 * MIN,
    windowMs: 24 * 60 * MIN,
    maxNudges: 3,
    log: (m) => logs.push(m),
    activity: (e) => activity.push(e),
    ...over.deps,
  });
  return { sweep, turns, store, logs, activity, off: () => void (enabled = false) };
};

describe("stale promise sweep", () => {
  test("steers a stale promise through the tell turn, unprompted, and logs it", async () => {
    const { sweep, turns, logs, activity } = setup();
    expect(await sweep.tick()).toBe(1);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ channelId: "C1", threadTs: "100.1", slackUserId: "U1", unprompted: true });
    expect(turns[0]?.text).toContain("[tell from another thread]");
    expect(turns[0]?.text).toContain("45 minutes ago");
    expect(turns[0]?.text).toContain("NO_REPLY");
    expect(logs.join("\n")).toContain("nudged C1:100.1");
    expect(activity).toEqual(["stale_promise_nudge"]);
  });

  test("nudges a bot message once, also across a restart, but a newer message again", async () => {
    const first = setup();
    await first.sweep.tick();
    await first.sweep.tick();
    expect(first.turns).toHaveLength(1);
    // A new process reading the same settings.
    const restarted = setup({ store: first.store });
    await restarted.sweep.tick();
    expect(restarted.turns).toHaveLength(0);
    const next = setup({
      store: first.store,
      replies: { "C1:100.1": [{ ts: ts(40), own: true, text: "I'll fix the table next." }] },
    });
    await next.sweep.tick();
    expect(next.turns).toHaveLength(1);
  });

  test("the off switch does nothing", async () => {
    const { sweep, turns, off } = setup();
    off();
    expect(await sweep.tick()).toBe(0);
    expect(turns).toHaveLength(0);
  });

  const blockers: [string, Partial<StalePromiseDeps>][] = [
    ["a running turn", { turnRunning: () => true }],
    ["a workflow", { workflowActive: () => true }],
    ["a waiting watch", { watches: () => 1 }],
    ["a waiting reminder", { reminders: () => 1 }],
    ["a live worker", { liveWorker: async () => true }],
    ["a worker that cannot be checked", { liveWorker: (): Promise<boolean> => Promise.reject(new Error("orca down")) }],
    ["a person who may no longer run turns", { mayRun: () => false }],
  ];
  test.each(blockers)("leaves a thread with %s alone", async (_n, deps) => {
    const { sweep, turns, store } = setup({ deps });
    expect(await sweep.tick()).toBe(0);
    expect(turns).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  test("leaves alone a thread where a human spoke last, or the message is too recent", async () => {
    const human = setup({
      replies: {
        "C1:100.1": [
          { ts: ts(45), own: true, text: PROMISE },
          { ts: ts(5), own: false, text: "ok" },
        ],
      },
    });
    await human.sweep.tick();
    expect(human.turns).toHaveLength(0);
    const recent = setup({ replies: { "C1:100.1": [{ ts: ts(5), own: true, text: PROMISE }] } });
    await recent.sweep.tick();
    expect(recent.turns).toHaveLength(0);
  });

  test("a plain answer or a question is not nudged", async () => {
    for (const text of ["All done, the post is updated.", "Do you want me to update the post next?"]) {
      const { sweep, turns } = setup({ replies: { "C1:100.1": [{ ts: ts(45), own: true, text }] } });
      await sweep.tick();
      expect(turns).toHaveLength(0);
    }
  });

  test("the model has the last word on a heuristic match, and a failed call means no nudge", async () => {
    const no = setup({ deps: { confirm: async () => false } });
    await no.sweep.tick();
    expect(no.turns).toHaveLength(0);
    const broken = setup({ deps: { confirm: async () => Promise.reject(new Error("timeout")) } });
    await broken.sweep.tick();
    expect(broken.turns).toHaveLength(0);
    expect(broken.store.size).toBe(0);
    const yes = setup({ deps: { confirm: async () => true } });
    await yes.sweep.tick();
    expect(yes.turns).toHaveLength(1);
  });

  test("caps nudges per sweep; the rest wait for the next one", async () => {
    const threads: EndedThread[] = [1, 2, 3, 4, 5].map((n) => ({
      channelId: "C1",
      threadTs: `${n}.1`,
      lastAt: NOW - 45 * MIN,
      slackUserId: "U1",
    }));
    const replies = Object.fromEntries(threads.map((t) => [`C1:${t.threadTs}`, [{ ts: ts(45), own: true, text: PROMISE }]]));
    const s = setup({ threads, replies, deps: { maxNudges: 2 } });
    expect(await s.sweep.tick()).toBe(2);
    expect(await s.sweep.tick()).toBe(2);
    expect(await s.sweep.tick()).toBe(1);
    expect(new Set(s.turns.map((t) => t.threadTs)).size).toBe(5);
  });

  test("a Slack failure in one thread does not stop the others", async () => {
    const threads: EndedThread[] = [
      { channelId: "C1", threadTs: "1.1", lastAt: NOW - 45 * MIN, slackUserId: "U1" },
      { channelId: "C1", threadTs: "2.1", lastAt: NOW - 45 * MIN, slackUserId: "U1" },
    ];
    const s = setup({
      threads,
      deps: {
        replies: async (_c, t) => {
          if (t === "1.1") throw new Error("ratelimited");
          return [{ ts: ts(45), own: true, text: PROMISE }];
        },
      },
    });
    expect(await s.sweep.tick()).toBe(1);
    expect(s.turns[0]?.threadTs).toBe("2.1");
  });
});
