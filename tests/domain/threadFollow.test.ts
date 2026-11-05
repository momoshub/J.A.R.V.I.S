import { describe, expect, test } from "bun:test";
import { couldFollowThread, mentionsBot, shouldFollowThread } from "../../src/domain/threadFollow.ts";
import { buildSystemPrompt } from "../../src/domain/personality.ts";
import { promptFingerprint } from "../../src/domain/promptFingerprint.ts";

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

describe("how it behaves once it is following", () => {
  const on = buildSystemPrompt({ learnings: [], following: true });
  const off = buildSystemPrompt({ learnings: [] });

  test("announcing the silence is forbidden, by name", () => {
    // it posted "I'm staying quiet here: ... a reaction is enough" into a
    // public channel - a message whose entire content was its decision not to
    // send a message, which is worse than simply answering
    expect(on).toContain("never ANNOUNCE the silence");
    expect(on).toContain("staying quiet here");
    expect(on).toContain("if the only content of your reply is about whether to reply");
  });

  test("silence is an explicit, permitted outcome", () => {
    // without this it answers every reply under its own thread, which turns one
    // useful summary into a running commentary
    expect(on).toContain("add NOTHING");
    expect(on).toContain("no text, not one word");
  });

  test("a reaction is offered as the usual size of response", () => {
    expect(on).toContain("react and say nothing else");
  });

  test("it may ask ONE question, and not for something it could look up", () => {
    expect(on).toContain("ask ONE short question");
    expect(on).toContain("never for something you could look up yourself");
  });

  test("the noise replies are named and forbidden", () => {
    expect(on).toContain("never reply merely to acknowledge, agree, thank");
    expect(on).toContain("let them");
  });

  test("none of it applies when somebody actually addressed it", () => {
    expect(off).not.toContain("MOST replies here do not need you");
  });

  test("the rule is in the session fingerprint, so live threads pick it up", () => {
    const a = promptFingerprint(buildSystemPrompt as never, "persona");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    // rendered under the sentinels, so a change to its text moves the hash
    expect(buildSystemPrompt({ learnings: [], following: true })).toContain("You are following this thread");
  });
});

describe("being asked to follow somebody else's thread", () => {
  test("the rule no longer claims it opened the thread", () => {
    // it can be following because it was ASKED to, and a rule that tells it
    // it started a conversation it did not start is a rule it will argue with
    const p = buildSystemPrompt({ learnings: [], following: true });
    expect(p).toContain("either because you started it or because somebody asked you");
    expect(p).not.toContain("you opened it, so you keep up with it");
  });

  test("silence is still the common outcome, whoever started it", () => {
    const p = buildSystemPrompt({ learnings: [], following: true });
    expect(p).toContain("MOST replies here do not need you at all");
    expect(p).toContain("never ANNOUNCE the silence");
  });
});

describe("shouldFollowThread", () => {
  const f = (o: Partial<Parameters<typeof shouldFollowThread>[0]> = {}) =>
    shouldFollowThread({ asked: false, ownThread: false, ownThreadsOff: false, ...o });

  test("a thread it opened, by default", () => {
    expect(f({ ownThread: true })).toBe(true);
    expect(f({ ownThread: false })).toBe(false);
  });

  test("a thread somebody asked it to follow", () => {
    expect(f({ asked: true })).toBe(true);
  });

  test("an explicit follow outranks the blanket setting", () => {
    // turning off the default and then pointing at one conversation means
    // exactly what it says
    expect(f({ asked: true, ownThreadsOff: true })).toBe(true);
  });

  test("the setting still silences its OWN threads", () => {
    expect(f({ ownThread: true, ownThreadsOff: true })).toBe(false);
  });
});
