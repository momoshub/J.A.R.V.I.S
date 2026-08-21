import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createAccessRequestRepo } from "../../src/infrastructure/db/accessRequestRepo.ts";
import { decideAccessRequest, GRANTED_ROLE, requestAccess } from "../../src/application/accessRequests.ts";
import { handleMessage } from "../../src/application/handleMessage.ts";
import type { SlackAdminPort } from "../../src/application/slackAdmin.ts";
import type { LlmPort } from "../../src/application/ports.ts";

const OWNER = "U0OWNER0001";
const STRANGER = "Ustranger";

type Posted = { channel: string; text: string; threadTs?: string };

const build = () => {
  const db = openDatabase(":memory:");
  const posts: Posted[] = [];
  let dm = 0;
  const slack: SlackAdminPort = {
    listConversations: async () => [],
    history: async () => ({ messages: [] }),
    replies: async () => [],
    update: async () => {},
    remove: async () => {},
    post: async (channel, text, threadTs) => {
      posts.push({ channel, text, threadTs });
    },
    postDm: async (userId, text) => {
      posts.push({ channel: userId, text });
      dm += 1;
      return { channel: `D-${userId}`, ts: `notice-${dm}` };
    },
    addReactions: async () => 0,
    resolveNames: async () => ({}),
  };
  const deps = {
    users: createUserRepo(db),
    messages: createMessageRepo(db),
    accessRequests: createAccessRequestRepo(db),
    slack,
    clock: () => 42,
    ownerSlackId: OWNER,
    llm: { complete: async () => "hello" } as LlmPort,
  };
  return { deps, posts };
};

const who = {
  slackUserId: STRANGER,
  displayName: "Robin",
  channelId: "C1",
  threadTs: "100.1",
  text: "jarvis can you help me",
};

describe("requestAccess", () => {
  test("asks the owner instead of refusing, and says so", async () => {
    const { deps, posts } = build();
    const reply = await requestAccess(deps, who, "not on the list");

    expect(reply).toContain("asked the owner");
    const toOwner = posts.find((p) => p.channel === OWNER);
    expect(toOwner?.text).toContain(`<@${STRANGER}>`);
    expect(toOwner?.text).toContain("Robin");
    expect(toOwner?.text).toContain("jarvis can you help me"); // what they said, quoted
    expect(toOwner?.text).toContain("✅");
    expect(toOwner?.text).toContain("❌");

    const pending = deps.accessRequests.pendingFor(STRANGER);
    expect(pending?.noticeTs).toBe("notice-1"); // remembered, so a reaction can find it
  });

  test("a second message does not ask the owner again", async () => {
    const { deps, posts } = build();
    await requestAccess(deps, who, "nope");
    const reply = await requestAccess(deps, who, "nope");

    expect(reply).toContain("already asked");
    expect(posts.filter((p) => p.channel === OWNER)).toHaveLength(1);
  });

  test("falls back to the plain refusal when the owner cannot be reached", async () => {
    const { deps } = build();
    deps.slack = { ...deps.slack, postDm: async () => undefined };
    expect(await requestAccess(deps, who, "not on the list")).toBe("not on the list");
  });

  test("without the repo wired up nothing changes", async () => {
    const { deps } = build();
    const bare = { ...deps, accessRequests: undefined };
    expect(await requestAccess(bare, who, "not on the list")).toBe("not on the list");
  });
});

describe("decideAccessRequest", () => {
  const notice = { channel: `D-${OWNER}`, ts: "notice-1" };

  test("✅ adds them as pal and answers where they asked", async () => {
    const { deps, posts } = build();
    await requestAccess(deps, who, "nope");

    const out = await decideAccessRequest(deps, {
      slackUserId: OWNER,
      reaction: "white_check_mark",
      ...notice,
    });

    expect(out.kind).toBe("approved");
    expect(deps.users.get(STRANGER)?.role).toBe(GRANTED_ROLE);
    const toThem = posts.find((p) => p.channel === "C1");
    expect(toThem?.text).toContain("you are in");
    expect(toThem?.threadTs).toBe("100.1"); // in the thread they spoke in
    expect(deps.accessRequests.pendingFor(STRANGER)).toBeUndefined();
  });

  test("❌ declines, tells them, and grants nothing", async () => {
    const { deps, posts } = build();
    await requestAccess(deps, who, "nope");

    const out = await decideAccessRequest(deps, { slackUserId: OWNER, reaction: "x", ...notice });

    expect(out.kind).toBe("rejected");
    expect(deps.users.get(STRANGER)).toBeUndefined();
    expect(posts.find((p) => p.channel === "C1")?.text).toContain("said no");
  });

  test("only the owner decides", async () => {
    const { deps } = build();
    await requestAccess(deps, who, "nope");
    const out = await decideAccessRequest(deps, {
      slackUserId: "Usomeone",
      reaction: "white_check_mark",
      ...notice,
    });
    expect(out.kind).toBe("ignored");
    expect(deps.users.get(STRANGER)).toBeUndefined();
  });

  test("other emoji, other messages and second reactions are ignored", async () => {
    const { deps } = build();
    await requestAccess(deps, who, "nope");

    expect((await decideAccessRequest(deps, { slackUserId: OWNER, reaction: "eyes", ...notice })).kind).toBe(
      "ignored",
    );
    expect(
      (await decideAccessRequest(deps, { slackUserId: OWNER, reaction: "x", channel: "D-x", ts: "9.9" })).kind,
    ).toBe("ignored");

    await decideAccessRequest(deps, { slackUserId: OWNER, reaction: "white_check_mark", ...notice });
    // already decided - a later ❌ must not undo it
    const again = await decideAccessRequest(deps, { slackUserId: OWNER, reaction: "x", ...notice });
    expect(again.kind).toBe("ignored");
    expect(deps.users.get(STRANGER)?.role).toBe(GRANTED_ROLE);
  });
});

describe("a stranger speaking", () => {
  test("gets the request flow rather than the old refusal, and is answered once approved", async () => {
    const { deps, posts } = build();

    const denied = await handleMessage(deps, {
      channelId: "C1",
      slackUserId: STRANGER,
      text: "hello?",
      displayName: "Robin",
      threadTs: "100.1",
    });
    expect(denied.kind).toBe("denied");
    expect(denied.kind === "denied" && denied.text).toContain("asked the owner");
    expect(deps.messages.count()).toBe(0); // nothing remembered for someone unknown

    await decideAccessRequest(deps, {
      slackUserId: OWNER,
      reaction: "white_check_mark",
      channel: `D-${OWNER}`,
      ts: "notice-1",
    });

    const now = await handleMessage(deps, { channelId: "C1", slackUserId: STRANGER, text: "hello?" });
    expect(now.kind).toBe("reply");
    expect(posts.some((p) => p.channel === "C1" && p.text.includes("you are in"))).toBe(true);
  });
});
