import { describe, expect, test } from "bun:test";
import { actOnMessageReaction, messageActionFor } from "../../src/application/messageReactions.ts";
import type { SlackAdminPort, SlackMessageRef } from "../../src/application/slackAdmin.ts";

const OWNER = "UOWNER";
const BOT = "UBOT";

const build = (msg: SlackMessageRef | undefined) => {
  const calls: string[] = [];
  const slack: SlackAdminPort = {
    listConversations: async () => [],
    history: async () => ({ messages: [] }),
    replies: async () => [],
    update: async () => {},
    remove: async (c, ts) => void calls.push(`remove ${c} ${ts}`),
    lookup: async () => msg,
    broadcast: async (c, ts) => void calls.push(`broadcast ${c} ${ts}`),
    unbroadcast: async (c, ts) => void calls.push(`unbroadcast ${c} ${ts}`),
    post: async () => undefined,
    postDm: async () => undefined,
    postDmInteractive: async () => undefined,
    postInteractive: async () => undefined,
    postMenu: async () => undefined,
    settleInteractive: async () => {},
    addReactions: async () => 0,
    botUserId: async () => BOT,
    resolveNames: async () => ({}),
  };
  return { calls, deps: { slack, ownerSlackId: OWNER } };
};

const reply = (over: Partial<SlackMessageRef> = {}): SlackMessageRef => ({
  ts: "2.0",
  userId: BOT,
  threadTs: "1.0",
  broadcast: false,
  text: "hello",
  ...over,
});

const react = (reaction: string, slackUserId = OWNER) => ({ slackUserId, reaction, channel: "C1", ts: "2.0" });

describe("message reactions", () => {
  test("maps the three reactions, skin tones included", () => {
    expect(messageActionFor("baby_symbol")).toBe("broadcast");
    expect(messageActionFor("bricks")).toBe("unbroadcast");
    expect(messageActionFor("sausage_punch")).toBe("delete");
    expect(messageActionFor("sausage_punch::skin-tone-2")).toBe("delete");
    expect(messageActionFor("thumbsup")).toBeUndefined();
  });

  test("baby_symbol sends a thread reply to the channel", async () => {
    const { calls, deps } = build(reply());
    expect((await actOnMessageReaction(deps, react("baby_symbol"))).kind).toBe("broadcast");
    expect(calls).toEqual(["broadcast C1 2.0"]);
  });

  test("baby_symbol leaves a top-level or already-broadcast message alone", async () => {
    for (const msg of [reply({ threadTs: undefined }), reply({ threadTs: "2.0" }), reply({ broadcast: true })]) {
      const { calls, deps } = build(msg);
      expect((await actOnMessageReaction(deps, react("baby_symbol"))).kind).toBe("ignored");
      expect(calls).toEqual([]);
    }
  });

  test("bricks takes a broadcast reply off the channel, nothing deleted", async () => {
    const { calls, deps } = build(reply({ broadcast: true }));
    expect(await actOnMessageReaction(deps, react("bricks"))).toEqual({ kind: "unbroadcast", ts: "2.0" });
    expect(calls).toEqual(["unbroadcast C1 2.0"]);
  });

  test("bricks on a reply that only lives in the thread does nothing", async () => {
    const { calls, deps } = build(reply());
    expect((await actOnMessageReaction(deps, react("bricks"))).kind).toBe("ignored");
    expect(calls).toEqual([]);
  });

  test("sausage_punch deletes the message", async () => {
    const { calls, deps } = build(reply({ threadTs: undefined }));
    expect((await actOnMessageReaction(deps, react("sausage_punch"))).kind).toBe("deleted");
    expect(calls).toEqual(["remove C1 2.0"]);
  });

  test("only the owner, and only on the bot's own messages", async () => {
    const someone = build(reply());
    expect((await actOnMessageReaction(someone.deps, react("sausage_punch", "UOTHER"))).kind).toBe("ignored");
    expect(someone.calls).toEqual([]);

    const theirs = build(reply({ userId: "UOTHER" }));
    expect((await actOnMessageReaction(theirs.deps, react("sausage_punch"))).kind).toBe("ignored");
    expect(theirs.calls).toEqual([]);

    const gone = build(undefined);
    expect((await actOnMessageReaction(gone.deps, react("sausage_punch"))).kind).toBe("ignored");
  });
});
