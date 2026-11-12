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

  test("a failing main turn is logged and still settles every submit, as a failure", async () => {
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
    // Still settles (the row is not held for ever), but as a failure.
    let settled: "ok" | "failed" | undefined;
    void gate.submit(K, item("a")).then(() => (settled = "ok"), () => (settled = "failed"));
    await clock.advance(25_000);
    expect(settled).toBe("failed");
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

describe("past the hard cap", () => {
  test("a slow gate and a steady stream of messages still ends in a reply by the cap", async () => {
    // The repro: a 3s gate and a message every 2.5s. Every answer was about a
    // batch somebody had just added to, so it was thrown away and asked again
    // at 0ms: 365 asks in 1000s, no reply, the batch still pending.
    const clock = fake();
    const ranAt: number[] = [];
    let asks = 0;
    const gate = createFollowGate<Item>({
      settings: () => gateSettings(() => undefined),
      now: clock.now,
      timers: clock.timers,
      log: () => {},
      decide: () => {
        asks++;
        return new Promise<GateDecision>((resolve) => {
          clock.timers.set(() => resolve({ verdict: "reply", reason: "r" }), 3_000);
        });
      },
      run: async () => {
        ranAt.push(clock.now());
      },
    });
    let i = 0;
    for (let t = 0; t < 200_000; t += 2_500) {
      void gate.submit(K, item(`m${i}`, String(i)));
      i++;
      await clock.advance(2_500);
    }
    expect(ranAt.length).toBeGreaterThan(0);
    // 90s cap from the first message, plus the gate's 3s.
    expect(ranAt[0]!).toBeLessThanOrEqual(93_000 + 2_500);
    expect(asks).toBeLessThan(20);
  });

  test("a superseded `wait` or `reply` past the cap answers the whole current batch, once", async () => {
    const t = setup({
      verdicts: async () => {
        await new Promise<void>((r) => t.clock.timers.set(() => r(), 3_000));
        return { verdict: "wait", reason: "unfinished" };
      },
    });
    // A message every 20s keeps the quiet window open until the cap (90s).
    for (let i = 0; i < 4; i++) {
      void t.gate.submit(K, item(`m${i}`, String(i)));
      await t.clock.advance(20_000);
    }
    void t.gate.submit(K, item("m4", "4")); // at 80s: due is clamped to the cap (90s)
    await t.clock.advance(11_500); // the gate starts reading at 90s...
    void t.gate.submit(K, item("late", "9")); // ...and a message lands mid-read
    await t.clock.advance(5_000);
    expect(t.ran).toHaveLength(1);
    expect(t.ran[0]!.map((x) => x.text)).toEqual(["m0", "m1", "m2", "m3", "m4", "late"]);
    expect(t.asked).toHaveLength(1);
    expect(t.gate.pending()).toBe(0);
  });

  test("a superseded `skip` is still never allowed to swallow the newer message", async () => {
    const t = setup({
      verdicts: async (n) => {
        await new Promise<void>((r) => t.clock.timers.set(() => r(), 3_000));
        return n === 1 ? { verdict: "skip", reason: "chat" } : { verdict: "reply", reason: "asked" };
      },
    });
    for (let i = 0; i < 4; i++) {
      void t.gate.submit(K, item(`m${i}`, String(i)));
      await t.clock.advance(20_000);
    }
    void t.gate.submit(K, item("m4", "4"));
    await t.clock.advance(11_500);
    void t.gate.submit(K, item("late", "9"));
    await t.clock.advance(30_000);
    expect(t.asked).toHaveLength(2);
    expect(t.ran).toHaveLength(1);
    expect(t.ran[0]!.map((x) => x.text)).toEqual(["m0", "m1", "m2", "m3", "m4", "late"]);
  });
});

describe("a message that bypasses the gate (cancel)", () => {
  test("takes the pending batch over: nothing fires later, the waiters settle", async () => {
    const t = setup({});
    const done: string[] = [];
    void t.gate.submit(K, item("A", "1")).then(() => done.push("A"));
    await t.clock.advance(5_000);
    void t.gate.submit(K, item("B", "2")).then(() => done.push("B"));
    await t.clock.advance(5_000);
    expect(t.gate.cancel(K, "tagged message")).toBe(2);
    await t.clock.advance(0);
    expect(done).toEqual(["A", "B"]);
    expect(t.gate.pending()).toBe(0);
    await t.clock.advance(300_000);
    expect(t.asked).toHaveLength(0);
    expect(t.ran).toHaveLength(0);
    expect(t.clock.pendingTimers()).toBe(0);
  });

  test("while the gate is reading, its answer is dropped and nothing is run", async () => {
    const t = setup({
      verdicts: async () => {
        await new Promise<void>((r) => t.clock.timers.set(() => r(), 3_000));
        return { verdict: "reply", reason: "r" };
      },
    });
    let settled = false;
    void t.gate.submit(K, item("A", "1")).then(() => (settled = true));
    await t.clock.advance(26_000); // asking now
    expect(t.asked).toHaveLength(1);
    t.gate.cancel(K, "command line");
    await t.clock.advance(10_000);
    expect(settled).toBe(true);
    expect(t.ran).toHaveLength(0);
    expect(t.gate.pending()).toBe(0);
  });

  test("a thread with nothing buffered is untouched, and a later message opens a fresh batch", async () => {
    const t = setup({});
    expect(t.gate.cancel(K, "tagged message")).toBe(0);
    void t.gate.submit(K, item("later", "5"));
    await t.clock.advance(25_000);
    expect(t.ran.map((b) => b.map((x) => x.text))).toEqual([["later"]]);
  });
});

describe("a turn that fails", () => {
  test("rejects every waiter, so the inbox rows are marked failed, not done", async () => {
    const clock = fake();
    const gate = createFollowGate<Item>({
      settings: () => gateSettings(() => undefined),
      now: clock.now,
      timers: clock.timers,
      log: () => {},
      decide: async () => ({ verdict: "reply", reason: "r" }),
      run: async () => {
        throw new Error("brain crashed");
      },
    });
    const out: string[] = [];
    void gate.submit(K, item("a", "1")).then(() => out.push("a ok"), (e: Error) => out.push(`a ${e.message}`));
    void gate.submit(K, item("b", "2")).then(() => out.push("b ok"), (e: Error) => out.push(`b ${e.message}`));
    await clock.advance(25_000);
    expect(out).toEqual(["a brain crashed", "b brain crashed"]);
  });
});
