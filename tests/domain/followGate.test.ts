import { describe, expect, test } from "bun:test";
import {
  addToBatch,
  capOf,
  failOpen,
  formatBatchInput,
  gateApplies,
  gateLogLine,
  gateMessage,
  gateSettings,
  gateSystem,
  isDue,
  outcomeOf,
  parseGateVerdict,
  type Batch,
} from "../../src/domain/followGate.ts";

const settings = (over: Record<string, string> = {}) => gateSettings((k) => over[k]);
const S = settings(); // 25s quiet, 90s cap
const msg = (text: string, ts = "1.0", userId = "U0PAL0001") => ({ userId, text, ts });

describe("gateSettings", () => {
  test("defaults: on, 25s quiet, 90s cap", () => {
    expect(S).toEqual({ enabled: true, quietMs: 25_000, maxMs: 90_000 });
  });
  test("off only on an explicit off, any case", () => {
    expect(settings({ follow_gate: "off" }).enabled).toBe(false);
    expect(settings({ follow_gate: " OFF " }).enabled).toBe(false);
    expect(settings({ follow_gate: "on" }).enabled).toBe(true);
    expect(settings({ follow_gate: "nonsense" }).enabled).toBe(true);
  });
  test("reads seconds and converts to ms", () => {
    const s = settings({ follow_debounce_seconds: "10", follow_debounce_max_seconds: "40" });
    expect([s.quietMs, s.maxMs]).toEqual([10_000, 40_000]);
  });
  test("junk or non-positive values fall back to the defaults", () => {
    for (const bad of ["", "abc", "0", "-5", "NaN"]) {
      const s = settings({ follow_debounce_seconds: bad, follow_debounce_max_seconds: bad });
      expect([s.quietMs, s.maxMs]).toEqual([25_000, 90_000]);
    }
  });
  test("the cap is never shorter than the quiet window, and both are bounded", () => {
    const s = settings({ follow_debounce_seconds: "120", follow_debounce_max_seconds: "30" });
    expect(s.maxMs).toBe(s.quietMs);
    const big = settings({ follow_debounce_seconds: "99999", follow_debounce_max_seconds: "99999" });
    expect(big.quietMs).toBe(600_000);
    expect(big.maxMs).toBe(600_000);
  });
});

describe("gateApplies", () => {
  const base = { enabled: true, route: "own-thread", isCommand: false };
  test("the two untagged routes go through the gate", () => {
    expect(gateApplies({ ...base, route: "own-thread" })).toBe(true);
    expect(gateApplies({ ...base, route: "asked" })).toBe(true);
  });
  test("one-on-one threads bypass it", () => {
    expect(gateApplies({ ...base, route: "one-on-one" })).toBe(false);
  });
  test("command lines bypass it", () => {
    expect(gateApplies({ ...base, isCommand: true })).toBe(false);
  });
  test("off bypasses it", () => {
    expect(gateApplies({ ...base, enabled: false })).toBe(false);
  });
  test("a skipped follow never gets here", () => {
    expect(gateApplies({ ...base, route: "not-ours" })).toBe(false);
  });
});

describe("batch windows", () => {
  test("the first message opens a batch due one quiet window later", () => {
    const b = addToBatch(undefined, msg("a"), 1_000, S);
    expect(b.items).toHaveLength(1);
    expect(b.firstAt).toBe(1_000);
    expect(b.dueAt).toBe(26_000);
    expect(isDue(b, 25_999)).toBe(false);
    expect(isDue(b, 26_000)).toBe(true);
  });
  test("each new message resets the quiet window and keeps order", () => {
    let b = addToBatch(undefined, msg("a"), 0, S);
    b = addToBatch(b, msg("b"), 20_000, S);
    b = addToBatch(b, msg("c"), 40_000, S);
    expect(b.items.map((i) => i.text)).toEqual(["a", "b", "c"]);
    expect(b.dueAt).toBe(65_000);
    expect(b.firstAt).toBe(0);
  });
  test("the hard cap counts from the first message and wins over the window", () => {
    let b: Batch | undefined;
    for (let t = 0; t <= 80_000; t += 20_000) b = addToBatch(b, msg(`m${t}`), t, S);
    // last arrival at 80s: quiet would say 105s, the cap says 90s
    expect(b!.dueAt).toBe(90_000);
    expect(capOf(b!, S)).toBe(90_000);
  });
  test("a new message clears an earlier wait", () => {
    let b = addToBatch(undefined, msg("a"), 0, S);
    const w = outcomeOf("wait", b, 25_000, S);
    expect(w.action).toBe("wait");
    if (w.action !== "wait") return;
    b = addToBatch(w.batch, msg("b"), 30_000, S);
    expect(b.waited).toBe(false);
  });
});

describe("outcomeOf", () => {
  const open = (at = 0) => addToBatch(undefined, msg("a"), at, S);
  test("reply and skip are final", () => {
    expect(outcomeOf("reply", open(), 25_000, S)).toEqual({ action: "reply" });
    expect(outcomeOf("skip", open(), 25_000, S)).toEqual({ action: "skip" });
  });
  test("wait extends the window once, bounded by the cap", () => {
    const o = outcomeOf("wait", open(), 25_000, S);
    expect(o.action).toBe("wait");
    if (o.action !== "wait") return;
    expect(o.batch.dueAt).toBe(50_000);
    expect(o.batch.waited).toBe(true);
    // a second wait on the same batch is a reply
    expect(outcomeOf("wait", o.batch, 50_000, S)).toEqual({ action: "reply" });
  });
  test("an extension never passes the cap", () => {
    const o = outcomeOf("wait", open(), 80_000, S);
    expect(o.action).toBe("wait");
    if (o.action !== "wait") return;
    expect(o.batch.dueAt).toBe(90_000);
  });
  test("at the cap, wait counts as reply", () => {
    expect(outcomeOf("wait", open(), 90_000, S)).toEqual({ action: "reply" });
    expect(outcomeOf("wait", open(), 120_000, S)).toEqual({ action: "reply" });
  });
});

describe("parseGateVerdict", () => {
  test("a JSON object", () => {
    expect(parseGateVerdict('{"verdict":"skip","reason":"people are chatting"}')).toEqual({
      verdict: "skip",
      reason: "people are chatting",
    });
  });
  test("a fenced JSON object with chatter around it", () => {
    const raw = 'Sure!\n```json\n{"verdict": "Wait", "reason": "half a question"}\n```\n';
    expect(parseGateVerdict(raw)).toEqual({ verdict: "wait", reason: "half a question" });
  });
  test("a bare word", () => {
    expect(parseGateVerdict("reply")).toEqual({ verdict: "reply", reason: "no reason given" });
    expect(parseGateVerdict("SKIP.")).toMatchObject({ verdict: "skip" });
  });
  test("verdict then reason on the same or the next line", () => {
    expect(parseGateVerdict("skip - just thanks")).toEqual({ verdict: "skip", reason: "just thanks" });
    expect(parseGateVerdict("Verdict: wait\nReason: still typing")).toEqual({ verdict: "wait", reason: "still typing" });
  });
  test("a JSON object with an unknown verdict is not trusted", () => {
    expect(parseGateVerdict('{"verdict":"maybe","reason":"x"}').verdict).toBe("reply");
  });
  test("empty, garbage and non-verdict prose fail open to reply", () => {
    for (const raw of ["", "   ", "I think so", "{not json", "null"]) {
      expect(parseGateVerdict(raw).verdict).toBe("reply");
    }
  });
  test("prose that merely contains a verdict word later is not read as one", () => {
    expect(parseGateVerdict("I would not skip this one").verdict).toBe("reply");
  });
  test("the reason is one clipped line", () => {
    const d = parseGateVerdict(JSON.stringify({ verdict: "skip", reason: `a\n\n  b ${"x".repeat(500)}` }));
    expect(d.reason.includes("\n")).toBe(false);
    expect(d.reason.length).toBeLessThanOrEqual(160);
  });
  test("failOpen is a reply with its reason", () => {
    expect(failOpen("boom")).toEqual({ verdict: "reply", reason: "boom" });
  });
});

describe("prompts and formatting", () => {
  test("the system prompt names the bot, the three verdicts and the lean to reply", () => {
    const s = gateSystem("Jarvis");
    expect(s).toContain("Jarvis");
    for (const v of ["reply", "skip", "wait"]) expect(s).toContain(v);
    expect(s).toContain("When unsure, choose reply");
  });
  test("the gate sees recent context then the batch, with authors, in order", () => {
    const m = gateMessage({
      botName: "Jarvis",
      context: [
        { author: "Ann", text: "deploy is red" },
        { author: "Jarvis", text: "looking", own: true },
      ],
      batch: [
        { author: "Bob", text: "same here" },
        { author: "Ann", text: "thanks" },
      ],
    });
    expect(m.indexOf("Ann: deploy is red")).toBeLessThan(m.indexOf("Jarvis (the bot): looking"));
    expect(m.indexOf("Bob: same here")).toBeLessThan(m.indexOf("Ann: thanks"));
    expect(m).toContain("(2)");
  });
  test("only the last few context lines are shown, each clipped", () => {
    const context = Array.from({ length: 20 }, (_, i) => ({ author: "A", text: `line${i} ${"y".repeat(1_000)}` }));
    const m = gateMessage({ botName: "J", context, batch: [{ author: "B", text: "hi" }] });
    expect(m).toContain("line19");
    expect(m).not.toContain("line10 ");
    expect(m.length).toBeLessThan(6 * 700 + 500);
  });
  test("an empty context says so", () => {
    expect(gateMessage({ botName: "J", context: [], batch: [{ author: "B", text: "hi" }] })).toContain("(nothing before this)");
  });
  test("a batch of one is the message itself", () => {
    expect(formatBatchInput([{ author: "Ann", text: "just this" }])).toBe("just this");
  });
  test("a larger batch lists every message in order under its author", () => {
    const t = formatBatchInput([
      { author: "Ann", text: "first" },
      { author: "Bob", text: "second" },
      { author: "Ann", text: "third" },
    ]);
    expect(t).toContain("3 messages");
    expect(t.indexOf("Ann: first")).toBeLessThan(t.indexOf("Bob: second"));
    expect(t.indexOf("Bob: second")).toBeLessThan(t.indexOf("Ann: third"));
  });
  test("the log line carries channel, thread, batch size, verdict and reason", () => {
    const line = gateLogLine({
      channel: "C1",
      threadTs: "9.9",
      size: 3,
      decision: { verdict: "skip", reason: "chatting" },
    });
    expect(line).toBe("follow gate channel=C1 thread=9.9 batch=3 verdict=skip: chatting");
    expect(gateLogLine({ channel: "C1", threadTs: "9.9", size: 1, decision: failOpen("x"), note: "n" })).toContain("(n)");
  });
});
