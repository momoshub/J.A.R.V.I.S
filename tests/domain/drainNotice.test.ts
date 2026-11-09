import { describe, expect, test } from "bun:test";
import { drainNotice, envelopeThread, unnotified, waitsForRestart } from "../../src/domain/drainNotice.ts";

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
    expect(envelopeThread(msg())).toEqual({ channel: "D1", threadTs: "1.1" });
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

  test("every channel counts, and a tagged top-level message is its own thread", () => {
    expect(envelopeThread(msg({ type: "app_mention", channel: "C1", text: "<@UBOT> hi" }))).toEqual({ channel: "C1", threadTs: "1.1" });
    expect(envelopeThread(msg({ channel: "C3", channel_type: "mpim", thread_ts: "9.9" }))).toEqual({ channel: "C3", threadTs: "9.9" });
    expect(envelopeThread(msg({ channel: "C1", channel_type: "im" }))).toEqual({ channel: "C1", threadTs: "1.1" });
  });

  test("a channel post nobody tagged it in is not a thread waiting on it", () => {
    const ask = "Hey <!subteam^S1>, could you review and approve https://github.com/o/r/pull/9";
    expect(envelopeThread(msg({ channel: "C1", channel_type: "channel", text: ask }))).toBeUndefined();
    expect(envelopeThread(msg({ channel: "C1", channel_type: "channel", thread_ts: "1.1" }))).toBeUndefined();
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

  test("lists every waiting thread, and none when nothing waits", () => {
    const text = drainNotice({ running: 1, deadlineMs }, ["https://x/a", "https://x/b"]);
    expect(text).toContain("- pending threads (2):");
    expect(text).toContain("  - https://x/a\n  - https://x/b");
    expect(drainNotice({ running: 1, deadlineMs })).not.toContain("pending threads");
  });
});

describe("what waits for the next process while a restart is pending", () => {
  const msg = (text: string, type = "message") => ({ type: "event_callback", event: { type, channel: "C1", user: "U1", text, ts: "1.1" } });
  const reply = (text: string) => ({ type: "event_callback", event: { type: "message", channel: "C1", user: "U1", text, ts: "2.2", thread_ts: "1.1" } });
  const dm = (text: string) => ({ type: "event_callback", event: { type: "message", channel: "D1", channel_type: "im", user: "U1", text, ts: "1.1" } });
  const P = ["X/jv", "!"];
  test("plain chat runs on its budget", () => {
    expect(waitsForRestart("events_api", msg("how is the deploy going?"), P)).toBe(false);
    expect(waitsForRestart("events_api", msg("<@UBOT> what changed today", "app_mention"), P)).toBe(false);
  });
  test("a command, typed or spoken, waits: it cannot be cut and picked up again", () => {
    expect(waitsForRestart("events_api", reply("X/jv workflow start ship it"), P)).toBe(true);
    expect(waitsForRestart("events_api", msg("<@UBOT> X/jv review 12", "app_mention"), P)).toBe(true);
    expect(waitsForRestart("events_api", dm("!ping"), P)).toBe(true);
    expect(waitsForRestart("events_api", reply("x/JV status"), P)).toBe(true);
    expect(waitsForRestart("events_api", msg("<@UBOT> review https://github.com/o/r/pull/9 please", "app_mention"), P)).toBe(true);
  });
  test("a review ask posted to somebody else, untagged and top-level, is not held", () => {
    const ask = "Hey <!subteam^S1>, could you review and approve https://github.com/o/r/pull/9 when you get a chance?";
    expect(waitsForRestart("events_api", msg(ask), P)).toBe(false);
    expect(waitsForRestart("events_api", msg("X/jv review 12"), P)).toBe(false);
    expect(waitsForRestart("events_api", reply(ask), P)).toBe(true);
    expect(waitsForRestart("events_api", dm(ask), P)).toBe(true);
  });
  test("slash commands and buttons wait; other events (reactions, stop) do not", () => {
    expect(waitsForRestart("slash_commands", { command: "/jv" }, P)).toBe(true);
    expect(waitsForRestart("interactive", { type: "block_actions" }, P)).toBe(true);
    expect(waitsForRestart("events_api", { event: { type: "reaction_added" } }, P)).toBe(false);
    expect(waitsForRestart("events_api", { event: { type: "agent_session_stopped" } }, P)).toBe(false);
  });
});
