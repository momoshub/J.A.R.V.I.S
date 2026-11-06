import { describe, expect, test } from "bun:test";
import { unfollowOnReaction } from "../../src/application/followReaction.ts";
import type { SlackAdminPort, SlackMessageRef } from "../../src/application/slackAdmin.ts";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createFollowRepo } from "../../src/infrastructure/db/followRepo.ts";

const OWNER = "UOWNER";
const BOT = "UBOT";

const build = (msg: SlackMessageRef | undefined) => {
  const posts: string[] = [];
  const slack: SlackAdminPort = {
    listConversations: async () => [],
    history: async () => ({ messages: [] }),
    replies: async () => [],
    update: async () => {},
    remove: async () => {},
    lookup: async () => msg,
    broadcast: async () => {},
    unbroadcast: async () => {},
    post: async (c, text) => void posts.push(`${c} ${text}`),
    postDm: async () => undefined,
    postDmInteractive: async () => undefined,
    postInteractive: async () => undefined,
    postMenu: async () => undefined,
    settleInteractive: async () => {},
    addReactions: async () => 0,
    botUserId: async () => BOT,
    resolveNames: async () => ({}),
  };
  const follows = createFollowRepo(openDatabase(":memory:"));
  follows.autoAdd("C1", "1.0", "U1", 1);
  return { posts, follows, deps: { slack, follows, ownerSlackId: OWNER, clock: () => 5 } };
};

const message = (over: Partial<SlackMessageRef> = {}): SlackMessageRef => ({
  ts: "2.0",
  userId: BOT,
  threadTs: "1.0",
  broadcast: false,
  text: "hello",
  ...over,
});

const react = (reaction = "rock", slackUserId = OWNER) => ({ slackUserId, reaction, channel: "C1", ts: "2.0" });

describe("rock switches following off", () => {
  test("on the bot's own message, silently, and it stays off", async () => {
    const { posts, follows, deps } = build(message());
    expect(await unfollowOnReaction(deps, react())).toEqual({ kind: "unfollowed", threadTs: "1.0" });
    expect(follows.isFollowed("C1", "1.0")).toBe(false);
    expect(follows.isOptedOut("C1", "1.0")).toBe(true);
    expect(posts).toEqual([]);
  });

  test("on a message that tags the bot", async () => {
    const { follows, deps } = build(message({ userId: "U2", text: "<@UBOT> thoughts?" }));
    expect((await unfollowOnReaction(deps, react("rock::skin-tone-2"))).kind).toBe("unfollowed");
    expect(follows.isFollowed("C1", "1.0")).toBe(false);
  });

  test("on the thread's parent, which is its own thread", async () => {
    const { follows, deps } = build(message({ ts: "1.0", threadTs: undefined, text: "<@UBOT> hi" }));
    expect((await unfollowOnReaction(deps, react())).kind).toBe("unfollowed");
    expect(follows.isOptedOut("C1", "1.0")).toBe(true);
  });

  test("ignored from anyone but the owner, on someone else's untagged message, or another emoji", async () => {
    for (const [msg, r] of [
      [message(), react("rock", "U2")],
      [message({ userId: "U2", text: "just chatting" }), react()],
      [message(), react("eyes")],
    ] as const) {
      const { follows, deps } = build(msg);
      expect((await unfollowOnReaction(deps, r)).kind).toBe("ignored");
      expect(follows.isFollowed("C1", "1.0")).toBe(true);
    }
  });
});
