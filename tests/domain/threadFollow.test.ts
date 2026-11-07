import { describe, expect, test } from "bun:test";
import { couldFollowThread, followSkipReason, followVerdict, isFollowOffReaction, isOneOnOneThread, mentionsBot, shouldFollowThread, startsAutoFollow } from "../../src/domain/threadFollow.ts";
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
    expect(couldFollowThread(reply({ subtype: "file_share" }), BOT)).toBe(true);
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

describe("isOneOnOneThread", () => {
  const bot = "UBOT";
  const f = (participants: string[], author = "U1") => isOneOnOneThread({ participants, author, botUserId: bot });

  test("the bot and one person is a one-on-one", () => {
    expect(f(["U1", bot])).toBe(true);
  });

  test("the author counts even before Slack lists them", () => {
    expect(f([bot], "U1")).toBe(true);
  });

  test("a second person ends it", () => {
    expect(f(["U1", bot], "U2")).toBe(false);
    expect(f(["U1", "U2", bot])).toBe(false);
  });

  test("a thread the bot never wrote in is not claimed", () => {
    expect(f(["U1"])).toBe(false);
  });
});

describe("shouldFollowThread and a one-on-one thread", () => {
  test("it is followed, whatever the blanket setting says", () => {
    expect(shouldFollowThread({ asked: false, ownThread: false, ownThreadsOff: true, oneOnOne: true })).toBe(true);
    expect(shouldFollowThread({ asked: false, ownThread: false, ownThreadsOff: false, oneOnOne: false })).toBe(false);
  });
});

describe("followSkipReason", () => {
  test("a candidate has no reason, and agrees with couldFollowThread", () => {
    expect(followSkipReason(reply(), BOT)).toBeUndefined();
    expect(couldFollowThread(reply(), BOT)).toBe(true);
  });

  test("each skip is named, so the log says why", () => {
    expect(followSkipReason(reply({ subtype: "message_changed" }), BOT)).toBe("subtype:message_changed");
    expect(followSkipReason(reply({ bot_id: "B1" }), BOT)).toBe("bot");
    expect(followSkipReason(reply({ text: "  " }), BOT)).toBe("empty");
    expect(followSkipReason(reply({ channel_type: "im" }), BOT)).toBe("dm");
    expect(followSkipReason(reply({ thread_ts: undefined }), BOT)).toBe("not-a-reply");
    expect(followSkipReason(reply({ user: BOT }), BOT)).toBe("self");
    expect(followSkipReason(reply({ text: "<@UBOT> hi" }), BOT)).toBe("tagged");
  });

  test("a group DM reply is a candidate like any channel reply", () => {
    expect(followSkipReason(reply({ channel_type: "mpim" }), BOT)).toBeUndefined();
  });
});

describe("followVerdict", () => {
  const base = { asked: false, ownThread: false, ownThreadsOff: false, oneOnOne: false };

  test("it names the route that let a message in", () => {
    expect(followVerdict({ ...base, asked: true })).toEqual({ follow: true, why: "asked" });
    expect(followVerdict({ ...base, oneOnOne: true, ownThreadsOff: true })).toEqual({ follow: true, why: "one-on-one" });
    expect(followVerdict({ ...base, ownThread: true })).toEqual({ follow: true, why: "own-thread" });
  });

  test("and why it kept a message out", () => {
    expect(followVerdict({ ...base, ownThreadsOff: true, ownThread: true })).toEqual({ follow: false, why: "own-threads-off" });
    expect(followVerdict(base)).toEqual({ follow: false, why: "not-ours" });
  });

  test("it always agrees with shouldFollowThread", () => {
    for (const asked of [false, true])
      for (const ownThread of [false, true])
        for (const ownThreadsOff of [false, true])
          for (const oneOnOne of [false, true])
            for (const optedOut of [false, true]) {
            const o = { asked, ownThread, ownThreadsOff, oneOnOne, optedOut };
            expect(followVerdict(o).follow).toBe(shouldFollowThread(o));
          }
  });
});

describe("an opted-out thread", () => {
  const base = { asked: false, ownThread: true, ownThreadsOff: false, oneOnOne: true, optedOut: true };

  test("no automatic route lets a message in", () => {
    expect(followVerdict(base)).toEqual({ follow: false, why: "opted-out" });
  });

  test("asking for it again still does", () => {
    expect(followVerdict({ ...base, asked: true })).toEqual({ follow: true, why: "asked" });
  });
});

describe("startsAutoFollow", () => {
  test("one person and the bot, even before the bot has replied", () => {
    expect(startsAutoFollow({ participants: ["U1"], author: "U1", botUserId: BOT })).toBe(true);
    expect(startsAutoFollow({ participants: ["U1", BOT], author: "U1", botUserId: BOT })).toBe(true);
    expect(startsAutoFollow({ participants: [], author: "U1", botUserId: BOT })).toBe(true);
  });

  test("not a thread two people were already talking in", () => {
    expect(startsAutoFollow({ participants: ["U1", "U2"], author: "U1", botUserId: BOT })).toBe(false);
    expect(startsAutoFollow({ participants: ["U1", BOT], author: "U2", botUserId: BOT })).toBe(false);
  });
});

describe("isFollowOffReaction", () => {
  test("rock, skin tone or not, and nothing else", () => {
    expect(isFollowOffReaction("rock")).toBe(true);
    expect(isFollowOffReaction("rock::skin-tone-2")).toBe(true);
    expect(isFollowOffReaction("rocket")).toBe(false);
    expect(isFollowOffReaction("eyes")).toBe(false);
  });
});
