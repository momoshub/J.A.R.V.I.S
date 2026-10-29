import { describe, expect, test } from "bun:test";
import { couldFollowThread, mentionsBot } from "../../src/domain/threadFollow.ts";

const BOT = "UBOT";
const reply = (over: Record<string, unknown> = {}) => ({
  user: "U1",
  text: "what about the allowlist?",
  channel_type: "channel",
  ts: "200.0",
  thread_ts: "100.0",
  ...over,
});

describe("mentionsBot", () => {
  test("it sees a tag in any of Slack's forms", () => {
    expect(mentionsBot("hey <@UBOT> look", BOT)).toBe(true);
    expect(mentionsBot("hey <@UBOT|jarvis> look", BOT)).toBe(true);
    expect(mentionsBot("hey <@UOTHER> look", BOT)).toBe(false);
    expect(mentionsBot("hey UBOT look", BOT)).toBe(false);
  });
});

describe("couldFollowThread", () => {
  test("a plain reply in a channel thread qualifies", () => {
    expect(couldFollowThread(reply(), BOT)).toBe(true);
  });

  test("a tagged message does not - the mention handler has it", () => {
    // otherwise the same message is answered twice
    expect(couldFollowThread(reply({ text: "<@UBOT> what now" }), BOT)).toBe(false);
  });

  test("its own messages never qualify", () => {
    // or it answers its own follow-ups forever
    expect(couldFollowThread(reply({ user: BOT }), BOT)).toBe(false);
    expect(couldFollowThread(reply({ bot_id: "B1", user: undefined }), BOT)).toBe(false);
  });

  test("a top-level message is not a thread reply", () => {
    expect(couldFollowThread(reply({ thread_ts: undefined }), BOT)).toBe(false);
    expect(couldFollowThread(reply({ thread_ts: "200.0" }), BOT)).toBe(false);
  });

  test("DMs are left to the DM handler", () => {
    expect(couldFollowThread(reply({ channel_type: "im" }), BOT)).toBe(false);
  });

  test("edits, joins and empty messages are not somebody talking", () => {
    expect(couldFollowThread(reply({ subtype: "message_changed" }), BOT)).toBe(false);
    expect(couldFollowThread(reply({ text: "   " }), BOT)).toBe(false);
    expect(couldFollowThread(reply({ user: undefined }), BOT)).toBe(false);
  });
});
