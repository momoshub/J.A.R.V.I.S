import { describe, expect, test } from "bun:test";
import { drainNotice, envelopeThread, unnotified } from "../../src/domain/drainNotice.ts";

// The real shape the gateway stores: Bolt's `body`, i.e. the event WRAPPER
// with the event at the top level - not nested under `payload`.
const msg = (over: Record<string, unknown> = {}) => ({
  type: "event_callback",
  event_id: "Ev1",
  event: { type: "message", channel: "D1", user: "U1", text: "hi", ts: "1.1", ...over },
});

describe("envelopeThread", () => {
  test("a message says where it was headed", () => {
    expect(envelopeThread(msg({ thread_ts: "9.9" }))).toEqual({ channel: "D1", threadTs: "9.9" });
    expect(envelopeThread(msg())).toEqual({ channel: "D1" });
  });

  test("the bot's own messages are nobody waiting", () => {
    expect(envelopeThread(msg({ bot_id: "B1" }))).toBeUndefined();
    expect(envelopeThread(msg({ subtype: "bot_message" }))).toBeUndefined();
  });

  test("an edit or a delete is nobody asking", () => {
    const edited = { type: "message", bot_id: "B1", text: "edited", ts: "5.5", thread_ts: "4.4" };
    expect(envelopeThread(msg({ subtype: "message_changed", user: undefined, message: edited }))).toBeUndefined();
    expect(envelopeThread(msg({ subtype: "message_deleted" }))).toBeUndefined();
  });

  test("a file or a broadcast from a person still counts", () => {
    expect(envelopeThread(msg({ subtype: "file_share", thread_ts: "9.9" }))).toEqual({ channel: "D1", threadTs: "9.9" });
    expect(envelopeThread(msg({ subtype: "thread_broadcast", thread_ts: "9.9" }))).toEqual({ channel: "D1", threadTs: "9.9" });
  });

  test("a press or a slash command has no thread to reassure", () => {
    expect(envelopeThread({ type: "block_actions", actions: [] })).toBeUndefined();
    expect(envelopeThread({})).toBeUndefined();
    expect(envelopeThread(msg({ channel: "" }))).toBeUndefined();
  });
});

describe("unnotified", () => {
  test("one notice per thread, however many times they ask", () => {
    const t = { channel: "D1", threadTs: "9.9" };
    const out = unnotified([t, t, t], new Set());
    expect(out).toHaveLength(1);
    expect(out[0]?.key).toBe("D1:9.9");
  });

  test("a thread already told is not told again", () => {
    expect(unnotified([{ channel: "D1", threadTs: "9.9" }], new Set(["D1:9.9"]))).toHaveLength(0);
  });

  test("different threads each get one", () => {
    const out = unnotified(
      [{ channel: "D1", threadTs: "1.1" }, { channel: "C2" }, { channel: "D1", threadTs: "2.2" }],
      new Set(),
    );
    expect(out.map((o) => o.key)).toEqual(["D1:1.1", "C2:", "D1:2.2"]);
  });
});

describe("drainNotice", () => {
  test("says it is coming back, and that nothing was lost", () => {
    expect(drainNotice()).toContain("saved");
    expect(drainNotice()).toContain("restarting");
  });

  const deadlineMs = Date.UTC(2026, 10, 7, 14, 30);

  test("names why, what it waits on, and the latest it comes back", () => {
    const text = drainNotice({ reason: "picking up #50 feat: more detail", running: 2, deadlineMs });
    expect(text).toContain("- why: picking up #50 feat: more detail");
    expect(text).toContain("waiting for 2 running turns to finish");
    expect(text).toContain(`<!date^${deadlineMs / 1000}^{time}|14:30 UTC>`);
  });

  test("one turn is a turn, and nothing running means seconds", () => {
    expect(drainNotice({ running: 1, deadlineMs })).toContain("1 running turn to finish");
    expect(drainNotice({ running: 0, deadlineMs })).toContain("nothing is running, back in a few seconds");
  });

  test("the API's filler reason is left out rather than shown", () => {
    expect(drainNotice({ reason: "requested over the local API", running: 0, deadlineMs })).not.toContain("why:");
    expect(drainNotice({ running: 0, deadlineMs })).not.toContain("why:");
  });
});
