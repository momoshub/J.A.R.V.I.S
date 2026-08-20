import { describe, expect, test } from "bun:test";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createLearningsRepo } from "../../src/infrastructure/db/learningsRepo.ts";
import { commandLineOf, dispatchCommand, type CommandDeps } from "../../src/application/commands.ts";
import type { AllowedUser } from "../../src/domain/types.ts";
import type { LlmPort } from "../../src/application/ports.ts";
import type { SlackAdminPort, SlackMessage } from "../../src/application/slackAdmin.ts";

const OWNER = "U0OWNER0001";

describe("commandLineOf", () => {
  const P = "X/ev";
  test("plain chat is not a command", () => {
    expect(commandLineOf("hey what's up", P)).toBeUndefined();
  });
  test("configured prefix", () => {
    expect(commandLineOf("X/ev add @u1 admin", P)).toBe("add @u1 admin");
    expect(commandLineOf("X/ev", P)).toBe("");
  });
  test("legacy ! prefix always works", () => {
    expect(commandLineOf("!whoami", P)).toBe("whoami");
  });
  test("tolerates a leading mention", () => {
    expect(commandLineOf("<@UBOT> X/ev help", P)).toBe("help");
  });
  test("default prefix when none configured", () => {
    expect(commandLineOf("//bot help")).toBe("help");
  });
});

let db: DbClient;
const actor = (over: Partial<AllowedUser> = {}): AllowedUser => ({
  slackId: OWNER,
  role: "owner",
  displayName: "Kai",
  addedBy: "system",
  createdAt: 0,
  ...over,
});

const llm: LlmPort = { complete: async () => "drafted answer" };

type SlackCalls = { posts: { channel: string; text: string; threadTs?: string }[]; reactions: string[] };

const fakeSlack = (calls: SlackCalls, thread: SlackMessage[] = []): SlackAdminPort => ({
  listConversations: async () => [],
  history: async () => ({ messages: [] }),
  replies: async () => thread,
  update: async () => {},
  remove: async () => {},
  post: async (channel, text, threadTs) => {
    calls.posts.push({ channel, text, threadTs });
  },
  postDm: async (userId, text) => {
    calls.posts.push({ channel: userId, text });
  },
  addReactions: async (_c, _ts, names) => {
    calls.reactions.push(...names);
    return names.length;
  },
  resolveNames: async () => ({}),
});

let slackCalls: SlackCalls;

const threadMsg = (text: string): SlackMessage => ({
  ts: "1.1",
  userId: "U1",
  userName: "Kai",
  text,
  replyCount: 0,
  own: false,
  mentionsBot: false,
});

const build = (thread: SlackMessage[] = [threadMsg("hi there")]): CommandDeps => {
  db = openDatabase(":memory:");
  slackCalls = { posts: [], reactions: [] };
  return {
    users: createUserRepo(db),
    messages: createMessageRepo(db),
    learnings: createLearningsRepo(db),
    llm,
    promptContext: () => ({ botName: "Evie", learnings: [] }),
    botInfo: () => ({ botName: "Evie", model: "claude-cli (opus)" }),
    clock: () => 42,
    ownerSlackId: OWNER,
    slack: fakeSlack(slackCalls, thread),
    draft: async () => "an AI-drafted reply",
  };
};

describe("dispatchCommand", () => {
  test("help lists commands available to the role", async () => {
    const deps = build();
    const owner = await dispatchCommand(deps, actor(), "C1", "help");
    expect(owner).toContain("promote");
    const member = await dispatchCommand(deps, actor({ slackId: "U3", role: "pal" }), "C1", "help");
    expect(member).not.toContain("promote");
    expect(member).toContain("ask");
  });

  test("unknown command is reported", async () => {
    expect(await dispatchCommand(build(), actor(), "C1", "frobnicate")).toContain("do not recognise");
  });

  test("role gate blocks under-privileged users", async () => {
    const deps = build();
    const out = await dispatchCommand(deps, actor({ slackId: "U3", role: "pal" }), "C1", "users");
    expect(out).toContain("admin");
    expect(out).toContain("access");
  });

  test("owner can add an admin; admin cannot", async () => {
    const deps = build();
    await dispatchCommand(deps, actor(), "C1", "add <@U1> admin");
    expect(deps.users.get("U1")?.role).toBe("admin");

    const deps2 = build();
    const admin = actor({ slackId: "U2", role: "admin" });
    const out = await dispatchCommand(deps2, admin, "C1", "add <@U1> admin");
    expect(out).toContain("Only the owner");
    expect(deps2.users.get("U1")).toBeUndefined();
  });

  test("owner cannot be removed", async () => {
    const deps = build();
    deps.users.upsert(actor());
    const out = await dispatchCommand(deps, actor(), "C1", `remove <@${OWNER}>`);
    expect(out).toContain("cannot be removed");
  });

  test("promote and demote (owner only)", async () => {
    const deps = build();
    deps.users.upsert({ slackId: "U1", role: "pal", displayName: "", addedBy: "x", createdAt: 1 });
    await dispatchCommand(deps, actor(), "C1", "promote <@U1>");
    expect(deps.users.get("U1")?.role).toBe("admin");
    await dispatchCommand(deps, actor(), "C1", "demote <@U1>");
    expect(deps.users.get("U1")?.role).toBe("pal");
  });

  test("forget clears the channel", async () => {
    const deps = build();
    deps.messages.append({ channelId: "C1", slackUserId: OWNER, role: "user", content: "x" }, 1);
    expect(await dispatchCommand(deps, actor(), "C1", "forget")).toContain("Wiped 1");
  });

  test("learn / learnings / unlearn", async () => {
    const deps = build();
    const learned = await dispatchCommand(deps, actor(), "C1", "learn staging is at x.example.com");
    expect(learned).toContain("Learned");
    expect(deps.learnings!.list()[0]?.content).toBe("staging is at x.example.com");
    expect(await dispatchCommand(deps, actor(), "C1", "learnings")).toContain("staging is at x");
    const id = deps.learnings!.list()[0]!.id;
    await dispatchCommand(deps, actor(), "C1", `unlearn ${id}`);
    expect(deps.learnings!.list()).toHaveLength(0);
  });

  test("ask calls the brain", async () => {
    const deps = build();
    expect(await dispatchCommand(deps, actor(), "C1", "ask what is 2+2")).toBe("drafted answer");
  });

  test("model reports the brain", async () => {
    expect(await dispatchCommand(build(), actor(), "C1", "model")).toContain("claude-cli (opus)");
  });

  const LINK = "https://team.slack.com/archives/C0TEST00001/p1787122692303399";

  test("rv reviews a PR via the brain", async () => {
    const out = await dispatchCommand(build(), actor(), "C1", "rv https://github.com/o/r/pull/1");
    expect(out).toBe("drafted answer");
  });

  test("rv needs a PR url", async () => {
    expect(await dispatchCommand(build(), actor(), "C1", "rv")).toContain("Which PR");
  });

  test("br bombs a linked message with reactions", async () => {
    const deps = build();
    const out = await dispatchCommand(deps, actor(), "C1", `br party ${LINK}`);
    expect(out).toContain("party");
    expect(slackCalls.reactions.length).toBeGreaterThan(0);
  });

  test("br rejects an unknown category", async () => {
    expect(await dispatchCommand(build(), actor(), "C1", `br notacategory ${LINK}`)).toContain("Unknown category");
  });

  test("br needs a link", async () => {
    expect(await dispatchCommand(build(), actor(), "C1", "br party")).toContain("message link");
  });

  test("jrp drafts and posts a reply to the linked thread", async () => {
    const deps = build();
    const out = await dispatchCommand(deps, actor(), "C1", `jrp ${LINK}`);
    expect(out).toContain("posted");
    expect(slackCalls.posts).toHaveLength(1);
    expect(slackCalls.posts[0]).toMatchObject({ channel: "C0TEST00001", text: "an AI-drafted reply", threadTs: "1787122692.303399" });
  });

  test("pal can review but not bomb/reply", async () => {
    const pal = actor({ slackId: "U9", role: "pal" });
    // review is pal-accessible (runs the brain), bomb/reply are admin-gated
    expect(await dispatchCommand(build(), pal, "C1", "rv https://github.com/o/r/pull/1")).toBe("drafted answer");
    expect(await dispatchCommand(build(), pal, "C1", `br party ${LINK}`)).toContain("access");
    expect(await dispatchCommand(build(), pal, "C1", `jrp ${LINK}`)).toContain("access");
  });
});
