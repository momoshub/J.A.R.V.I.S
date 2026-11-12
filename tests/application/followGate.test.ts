import { describe, expect, test } from "bun:test";
import { createFollowGate, type GateTimers } from "../../src/application/followGate.ts";
import { failOpen, gateSettings, type GateDecision, type GateSettings } from "../../src/domain/followGate.ts";

type Timer = { at: number; fn: () => void; id: number };

/** A clock and timers that only move when the test moves them. */
const fake = () => {
  let now = 0;
  let nextId = 1;
  let timers: Timer[] = [];
  const api: GateTimers = {
    set: (fn, ms) => {
      const t = { at: now + ms, fn, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clear: (h) => {
      timers = timers.filter((t) => t.id !== h);
    },
  };
  const advance = async (ms: number) => {
    const to = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= to).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = due.at;
      due.fn();
      await flush();
    }
    now = to;
    await flush();
  };
  return { now: () => now, timers: api, advance, pendingTimers: () => timers.length };
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

type Item = { userId: string; text: string; ts: string };
const item = (text: string, ts = "1.0"): Item => ({ userId: "U0PAL0001", text, ts });
const K = { channel: "C1", threadTs: "9.9" };

const setup = (opts: {
  verdicts?: GateDecision[] | ((n: number, items: readonly Item[]) => Promise<GateDecision>);
  settings?: () => GateSettings;
  gateTimeoutMs?: number;
}) => {
  const clock = fake();
  const logs: string[] = [];
  const asked: Item[][] = [];
  const ran: Item[][] = [];
  const queue = Array.isArray(opts.verdicts) ? [...opts.verdicts] : [];
  const gate = createFollowGate<Item>({
    settings: opts.settings ?? (() => gateSettings(() => undefined)),
    now: clock.now,
    timers: clock.timers,
    log: (l) => logs.push(l),
    gateTimeoutMs: opts.gateTimeoutMs,
    decide: async ({ items }) => {
      asked.push([...items]);
      if (typeof opts.verdicts === "function") return opts.verdicts(asked.length, items);
      return queue.shift() ?? { verdict: "reply", reason: "default" };
    },
    run: async ({ items }) => {
      ran.push([...items]);
    },
  });
  return { gate, clock, logs, asked, ran };
};

describe("createFollowGate", () => {
  test("a lone message is held for the quiet window, then judged and answered once", async () => {
    const t = setup({ verdicts: [{ verdict: "reply", reason: "asked a question" }] });
    let settled = false;
    void t.gate.submit(K, item("hello")).then(() => (settled = true));
    await t.clock.advance(24_999);
    expect(t.asked).toHaveLength(0);
    expect(settled).toBe(false);
    await t.clock.advance(1);
    expect(t.asked).toHaveLength(1);
    expect(t.ran).toHaveLength(1);
    expect(t.ran[0]!.map((i) => i.text)).toEqual(["hello"]);
    expect(settled).toBe(true);
    expect(t.gate.pending()).toBe(0);
  });

  test("a burst is one batch: every message in order, one gate call, one turn", async () => {
    const t = setup({ verdicts: [{ verdict: "reply", reason: "r" }] });
    void t.gate.submit(K, item("a", "1"));
    await t.clock.advance(10_000);
    void t.gate.submit(K, item("b", "2"));
    await t.clock.advance(20_000);
    void t.gate.submit(K, item("c", "3"));
    await t.clock.advance(24_999);
    expect(t.asked).toHaveLength(0);
    await t.clock.advance(1);
    expect(t.asked).toHaveLength(1);
    expect(t.ran).toHaveLength(1);
    expect(t.ran[0]!.map((i) => i.text)).toEqual(["a", "b", "c"]);
  });

  test("every submit settles when the batch does, so each inbox row stays open that long", async () => {
    const t = setup({ verdicts: [{ verdict: "skip", reason: "chat" }] });
    const done: string[] = [];
    void t.gate.submit(K, item("a")).then(() => done.push("a"));
    void t.gate.submit(K, item("b")).then(() => done.push("b"));
    await t.clock.advance(24_000);
    expect(done).toEqual([]);
    await t.clock.advance(1_000);
    expect(done).toEqual(["a", "b"]);
  });

  test("skip runs no main turn and logs the reason", async () => {
    const t = setup({ verdicts: [{ verdict: "skip", reason: "people are chatting" }] });
    void t.gate.submit(K, item("lol"));
    await t.clock.advance(25_000);
    expect(t.ran).toHaveLength(0);
    expect(t.logs).toEqual(["follow gate channel=C1 thread=9.9 batch=1 verdict=skip: people are chatting"]);
  });

  test("the cap holds a busy thread to 90s from the first message", async () => {
    const t = setup({ verdicts: [{ verdict: "reply", reason: "r" }] });
    // a message every 20s keeps the quiet window from ever ending
    for (let i = 0; i < 5; i++) {
      void t.gate.submit(K, item(`m${i}`));
      await t.clock.advance(20_000);
    }
    // 100s in: the cap (90s) must already have fired once
    expect(t.asked.length).toBeGreaterThanOrEqual(1);
    expect(t.ran.length).toBeGreaterThanOrEqual(1);
    expect(t.ran[0]!.length).toBeLessThanOrEqual(5);
  });

  test("wait extends the window once; the second look decides", async () => {
    const t = setup({
      verdicts: [
        { verdict: "wait", reason: "half a question" },
        { verdict: "reply", reason: "complete now" },
      ],
    });
    void t.gate.submit(K, item("how do I"));
    await t.clock.advance(25_000);
    expect(t.asked).toHaveLength(1);
    expect(t.ran).toHaveLength(0);
    expect(t.logs[0]).toContain("verdict=wait");
    expect(t.logs[0]).toContain("window extended");
    await t.clock.advance(25_000);
    expect(t.asked).toHaveLength(2);
    expect(t.ran).toHaveLength(1);
  });

  test("a second wait on the same batch is answered, not waited on again", async () => {
    const t = setup({ verdicts: [{ verdict: "wait", reason: "w1" }, { verdict: "wait", reason: "w2" }] });
    void t.gate.submit(K, item("x"));
    await t.clock.advance(25_000);
    await t.clock.advance(25_000);
    expect(t.asked).toHaveLength(2);
    expect(t.ran).toHaveLength(1);
    expect(t.logs[1]).toContain("verdict=reply");
  });

  test("wait at the cap counts as reply", async () => {
    // quiet 60s, cap 90s: the first look is at 60s, its extension is clipped to 90s
    const t = setup({
      settings: () => gateSettings((k) => ({ follow_debounce_seconds: "60", follow_debounce_max_seconds: "90" })[k]),
      verdicts: [{ verdict: "wait", reason: "w" }, { verdict: "wait", reason: "w" }],
    });
    void t.gate.submit(K, item("x"));
    await t.clock.advance(60_000);
    expect(t.ran).toHaveLength(0);
    await t.clock.advance(30_000);
    expect(t.asked).toHaveLength(2);
    expect(t.ran).toHaveLength(1);
  });

  test("a message arriving after a wait restarts the window and joins the batch", async () => {
    const t = setup({ verdicts: [{ verdict: "wait", reason: "w" }, { verdict: "reply", reason: "r" }] });
    void t.gate.submit(K, item("how do I"));
    await t.clock.advance(25_000);
    void t.gate.submit(K, item("deploy this?"));
    await t.clock.advance(24_999);
    expect(t.asked).toHaveLength(1);
    await t.clock.advance(1);
    expect(t.asked).toHaveLength(2);
    expect(t.ran[0]!.map((i) => i.text)).toEqual(["how do I", "deploy this?"]);
  });

  test("a gate error fails open to reply", async () => {
    const t = setup({
      verdicts: async () => {
        throw new Error("haiku is down");
      },
    });
    void t.gate.submit(K, item("x"));
    await t.clock.advance(25_000);
    expect(t.ran).toHaveLength(1);
    expect(t.logs[0]).toContain("verdict=reply");
    expect(t.logs[0]).toContain("haiku is down");
  });

  test("a gate that never answers times out to reply", async () => {
    const t = setup({ verdicts: () => new Promise<GateDecision>(() => undefined), gateTimeoutMs: 20_000 });
    void t.gate.submit(K, item("x"));
    await t.clock.advance(25_000);
    expect(t.ran).toHaveLength(0);
    await t.clock.advance(20_000);
    expect(t.ran).toHaveLength(1);
    expect(t.logs[0]).toContain("timed out");
  });

  test("a message that lands while the gate is reading supersedes its answer", async () => {
    let release: (d: GateDecision) => void = () => undefined;
    const t = setup({
      verdicts: (n) =>
        n === 1
          ? new Promise<GateDecision>((r) => {
              release = r;
            })
          : Promise.resolve({ verdict: "reply", reason: "second look" }),
    });
    void t.gate.submit(K, item("a"));
    await t.clock.advance(25_000);
    expect(t.asked).toHaveLength(1);
    void t.gate.submit(K, item("b"));
    release({ verdict: "skip", reason: "stale" });
    await t.clock.advance(0);
    // the skip was about a batch that no longer exists: nothing is dropped
    expect(t.ran).toHaveLength(0);
    expect(t.logs[0]).toContain("superseded");
    await t.clock.advance(25_000);
    expect(t.asked).toHaveLength(2);
    expect(t.asked[1]!.map((i) => i.text)).toEqual(["a", "b"]);
    expect(t.ran).toHaveLength(1);
  });

  test("threads are independent", async () => {
    const t = setup({});
    void t.gate.submit({ channel: "C1", threadTs: "1.1" }, item("one"));
    await t.clock.advance(10_000);
    void t.gate.submit({ channel: "C1", threadTs: "2.2" }, item("two"));
    await t.clock.advance(15_000);
    expect(t.ran.map((b) => b.map((i) => i.text))).toEqual([["one"]]);
    await t.clock.advance(10_000);
    expect(t.ran.map((b) => b.map((i) => i.text))).toEqual([["one"], ["two"]]);
  });

  test("a message during the main turn opens the next batch", async () => {
    const clock = fake();
    const ran: string[][] = [];
    let finish: () => void = () => undefined;
    const gate = createFollowGate<Item>({
      settings: () => gateSettings(() => undefined),
      now: clock.now,
      timers: clock.timers,
      log: () => undefined,
      decide: async () => ({ verdict: "reply", reason: "r" }),
      run: ({ items }) =>
        new Promise<void>((r) => {
          ran.push(items.map((i) => i.text));
          finish = r;
        }),
    });
    void gate.submit(K, item("first"));
    await clock.advance(25_000);
    expect(ran).toEqual([["first"]]);
    void gate.submit(K, item("second"));
    expect(gate.pending()).toBe(1);
    finish();
    await clock.advance(25_000);
    expect(ran).toEqual([["first"], ["second"]]);
  });

  test("a failing main turn is logged and still settles every submit", async () => {
    const clock = fake();
    const logs: string[] = [];
    const gate = createFollowGate<Item>({
      settings: () => gateSettings(() => undefined),
      now: clock.now,
      timers: clock.timers,
      log: (l) => logs.push(l),
      decide: async () => failOpen("x"),
      run: async () => {
        throw new Error("turn blew up");
      },
    });
    let settled = false;
    void gate.submit(K, item("a")).then(() => (settled = true));
    await clock.advance(25_000);
    expect(settled).toBe(true);
    expect(logs.some((l) => l.includes("turn blew up"))).toBe(true);
  });

  test("switching the gate off while messages wait answers them without asking the model", async () => {
    let on = true;
    const t = setup({ settings: () => ({ ...gateSettings(() => undefined), enabled: on }) });
    void t.gate.submit(K, item("a"));
    on = false;
    await t.clock.advance(25_000);
    expect(t.asked).toHaveLength(0);
    expect(t.ran).toHaveLength(1);
    expect(t.logs[0]).toContain("gate off");
  });

  test("settings are read per message, so a change needs no restart", async () => {
    let quiet = "25";
    const t = setup({ settings: () => gateSettings((k) => (k === "follow_debounce_seconds" ? quiet : undefined)) });
    quiet = "5";
    void t.gate.submit(K, item("a"));
    await t.clock.advance(5_000);
    expect(t.ran).toHaveLength(1);
  });
});
