import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createAccessRequestRepo } from "../../src/infrastructure/db/accessRequestRepo.ts";
import { decideAccessRequest, GRANTED_ROLE, REJECTED_COOLDOWN_MS, requestAccess } from "../../src/application/accessRequests.ts";
import { handleMessage } from "../../src/application/handleMessage.ts";
import type { SlackAdminPort } from "../../src/application/slackAdmin.ts";
import type { LlmPort } from "../../src/application/ports.ts";

const OWNER = "U0OWNER0001";
const STRANGER = "Ustranger";

type Posted = { channel: string; text: string; threadTs?: string };

const build = () => {
  const db = openDatabase(":memory:");
  const posts: Posted[] = [];
  const settled: string[] = [];
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
    postDmInteractive: async () => undefined,
    settleInteractive: async (_c, _ts, text) => {
      settled.push(text);
    },
    addReactions: async () => 0,
    botUserId: async () => "UBOT",
    resolveNames: async () => ({}),
  };
  const deps: {
    users: ReturnType<typeof createUserRepo>;
    messages: ReturnType<typeof createMessageRepo>;
    accessRequests: ReturnType<typeof createAccessRequestRepo>;
    slack: SlackAdminPort;
    clock: () => number;
    ownerSlackId: string;
    llm: LlmPort;
  } = {
    users: createUserRepo(db),
    messages: createMessageRepo(db),
    accessRequests: createAccessRequestRepo(db),
    slack,
    clock: () => 42,
    ownerSlackId: OWNER,
    llm: { complete: async () => "hello" } as LlmPort,
  };
  return { deps, posts, settled };
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

    // the notice is remembered, so a reaction on it can find the request
    const pending = deps.accessRequests.pendingFor(STRANGER)!;
    expect(deps.accessRequests.noticesFor(pending.id)).toEqual([{ channel: `D-${OWNER}`, ts: "notice-1" }]);
  });

  test("answers once, then says nothing while they wait", async () => {
    const { deps, posts } = build();
    expect(await requestAccess(deps, who, "nope")).toContain("asked the owner");

    // someone tagging repeatedly must not produce a wall of identical replies
    for (let i = 0; i < 5; i++) expect(await requestAccess(deps, who, "nope")).toBeUndefined();
    expect(posts.filter((p) => p.channel === OWNER)).toHaveLength(1);
  });

  test("a declined person cannot re-raise it by asking again", async () => {
    const { deps, posts } = build();
    await requestAccess(deps, who, "nope");
    const notices = deps.accessRequests.noticesFor(deps.accessRequests.pendingFor(STRANGER)!.id);
    await decideAccessRequest(deps, { slackUserId: OWNER, reaction: "x", ...notices[0]! });

    const before = posts.filter((p) => p.channel === OWNER).length;
    for (let i = 0; i < 5; i++) expect(await requestAccess(deps, who, "nope")).toBeUndefined();
    expect(posts.filter((p) => p.channel === OWNER)).toHaveLength(before); // no second notice
  });

  test("after the cooldown they may ask again", async () => {
    const { deps, posts } = build();
    await requestAccess(deps, who, "nope");
    const notices = deps.accessRequests.noticesFor(deps.accessRequests.pendingFor(STRANGER)!.id);
    await decideAccessRequest(deps, { slackUserId: OWNER, reaction: "x", ...notices[0]! });

    deps.clock = () => 42 + REJECTED_COOLDOWN_MS + 1;
    expect(await requestAccess(deps, who, "nope")).toContain("asked the owner");
    expect(posts.filter((p) => p.channel === OWNER).length).toBeGreaterThan(1);
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

describe("a stranger who keeps tagging", () => {
  test("gets one reply, and the conversation is not filled with refusals", async () => {
    const { deps } = build();
    const say = (text: string) =>
      handleMessage(deps, { channelId: "C1", slackUserId: STRANGER, text, displayName: "Robin" });

    const first = await say("jarvis?");
    expect(first.kind).toBe("denied"); // answered once

    for (const text of ["jarvis??", "hello", "are you there", "please"]) {
      expect((await say(text)).kind).toBe("ignored"); // and then nothing
    }
  });
});

describe("admins decide too", () => {
  const ADMIN = "U0ADMIN01";

  const withAdmin = () => {
    const b = build();
    b.deps.users.upsert({ slackId: ADMIN, role: "admin", displayName: "A", addedBy: "x", createdAt: 1 });
    b.deps.users.upsert({ slackId: "U0PAL0001", role: "pal", displayName: "P", addedBy: "x", createdAt: 1 });
    return b;
  };

  test("the notice goes to the owner and every admin, not just the owner", async () => {
    const { deps, posts } = withAdmin();
    await requestAccess(deps, who, "nope");

    const asked = posts.filter((p) => p.text.includes("is asking me something")).map((p) => p.channel);
    expect(asked).toContain(OWNER);
    expect(asked).toContain(ADMIN);
    expect(asked).not.toContain("U0PAL0001"); // a pal does not get to decide
  });

  test("an admin's ✅ resolves it, from their own copy of the notice", async () => {
    const { deps } = withAdmin();
    await requestAccess(deps, who, "nope");
    // the admin's notice is the second one raised
    const notices = deps.accessRequests.noticesFor(deps.accessRequests.pendingFor(STRANGER)!.id);
    expect(notices).toHaveLength(2);

    const out = await decideAccessRequest(deps, {
      slackUserId: ADMIN,
      reaction: "white_check_mark",
      ...notices[1]!,
    });

    expect(out.kind).toBe("approved");
    expect(deps.users.get(STRANGER)?.role).toBe(GRANTED_ROLE);
  });

  test("deciding settles every copy, so the other decider does not act on a stale one", async () => {
    const { deps, settled } = withAdmin();
    await requestAccess(deps, who, "nope");
    const notices = deps.accessRequests.noticesFor(deps.accessRequests.pendingFor(STRANGER)!.id);

    await decideAccessRequest(deps, { slackUserId: OWNER, reaction: "x", ...notices[0]! });

    expect(settled).toHaveLength(2); // both the owner's and the admin's
    expect(settled[0]).toContain("declined");
    // and the admin clicking afterwards changes nothing
    const late = await decideAccessRequest(deps, {
      slackUserId: ADMIN,
      reaction: "white_check_mark",
      ...notices[1]!,
    });
    expect(late.kind).toBe("ignored");
    expect(deps.users.get(STRANGER)).toBeUndefined();
  });

  test("a pal still cannot decide", async () => {
    const { deps } = withAdmin();
    await requestAccess(deps, who, "nope");
    const notices = deps.accessRequests.noticesFor(deps.accessRequests.pendingFor(STRANGER)!.id);

    const out = await decideAccessRequest(deps, {
      slackUserId: "U0PAL0001",
      reaction: "white_check_mark",
      ...notices[0]!,
    });
    expect(out.kind).toBe("ignored");
    expect(deps.users.get(STRANGER)).toBeUndefined();
  });
});
