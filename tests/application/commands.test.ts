import { describe, expect, test } from "bun:test";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createLearningsRepo } from "../../src/infrastructure/db/learningsRepo.ts";
import { commandLineOf, dispatchCommand, type CommandDeps } from "../../src/application/commands.ts";
import { respond, type RespondDeps } from "../../src/application/respond.ts";
import type { AllowedUser } from "../../src/domain/types.ts";
import type { LlmPort } from "../../src/application/ports.ts";
import type { SlackAdminPort, SlackMessage } from "../../src/application/slackAdmin.ts";
import type { GitHubPort } from "../../src/application/github.ts";
import { BOMB_SIZE } from "../../src/domain/emoji.ts";

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

type SlackCalls = {
  posts: { channel: string; text: string; threadTs?: string }[];
  reactions: string[];
  removed: { channel: string; ts: string }[];
  buttons: string[];
  settled: { channel: string; ts: string; text: string }[];
  removeError?: Error;
};

const fakeSlack = (calls: SlackCalls, thread: SlackMessage[] = []): SlackAdminPort => ({
  listConversations: async () => [],
  history: async () => ({ messages: [] }),
  replies: async () => thread,
  update: async () => {},
  remove: async (channel, ts) => {
    if (calls.removeError) throw calls.removeError;
    calls.removed.push({ channel, ts });
  },
  post: async (channel, text, threadTs) => {
    calls.posts.push({ channel, text, threadTs });
  },
  postDm: async (userId, text) => {
    calls.posts.push({ channel: userId, text });
    return { channel: userId, ts: `dm-${calls.posts.length}` };
  },
  postDmInteractive: async (userId, text, actions) => {
    calls.posts.push({ channel: userId, text });
    calls.buttons.push(...actions.map((a) => `${a.actionId}:${a.value}`));
    return { channel: userId, ts: `notice-${calls.posts.length}` };
  },
  settleInteractive: async (channel, ts, text) => {
    calls.settled.push({ channel, ts, text });
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
  slackCalls = { posts: [], reactions: [], removed: [], buttons: [], settled: [] };
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

  test("a mention still reads after the transport has annotated it", async () => {
    // production sends `<@U1:Robin>`, not `<@U1>` - reading only the bare form
    // made every @user command silently target nobody
    const deps = build();
    await dispatchCommand(deps, actor(), "C1", "add <@U1:Robin> admin");
    expect(deps.users.get("U1")?.role).toBe("admin");

    await dispatchCommand(deps, actor(), "C1", "demote <@U1:Robin>");
    expect(deps.users.get("U1")?.role).toBe("pal");

    const limit = await dispatchCommand(deps, actor(), "C1", "limit <@U1:Robin> 25");
    expect(limit).toContain("<@U1>");
    expect(limit).toContain("25");
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

  test("rv approves in code before the brain runs, and says so first", async () => {
    const PR = "https://github.com/o/r/pull/1";
    const order: string[] = [];
    const github: GitHubPort = {
      whoami: async () => ({ login: "kai-at-acme", name: "Kai" }),
      approve: async (url) => {
        order.push(`approve:${url}`);
        return { ok: true };
      },
    };
    let system = "";
    const slow: LlmPort = {
      complete: async (p) => {
        order.push("brain");
        system = p.system;
        return "the review";
      },
    };
    const lines: string[] = [];
    // Slack-wrapped link: the bare url must be what gets approved and prompted.
    await dispatchCommand({ ...build(), github, llm: slow }, actor(), "C1", `rv <${PR}|o/r#1>`, {
      reply: async (t: string) => {
        lines.push(t);
      },
    });

    expect(order).toEqual([`approve:${PR}`, "brain"]); // approved before the model starts
    expect(lines[0]).toBe(`✅ approved ${PR}`);
    expect(lines[1]).toBe(`🔍 reviewing ${PR}`);
    expect(lines[lines.length - 1]).toBe("the review");
    // the resolved account reaches the prompt, so the brain need not look it up
    expect(system).toContain("Write it as Kai, an engineer");
    expect(system).toContain("kai-at-acme");
  });

  test("rv reports a refused approval and reviews anyway", async () => {
    const PR = "https://github.com/o/r/pull/1";
    const github: GitHubPort = {
      whoami: async () => undefined,
      approve: async () => ({ ok: false, error: "can not approve your own PR" }),
    };
    const lines: string[] = [];
    await dispatchCommand({ ...build(), github }, actor(), "C1", `rv ${PR}`, {
      reply: async (t: string) => {
        lines.push(t);
      },
    });
    expect(lines[0]).toBe(`⚠️ could not approve ${PR} - can not approve your own PR`);
    expect(lines[1]).toContain("reviewing");
    expect(lines[lines.length - 1]).toBe("drafted answer"); // review still ran
  });

  test("rv does not repeat the approve line if the brain approves too", async () => {
    const PR = "https://github.com/o/r/pull/1";
    const github: GitHubPort = { whoami: async () => undefined, approve: async () => ({ ok: true }) };
    const streamed: LlmPort = {
      complete: async () => "unused",
      stream: async (_p, sink) => {
        const command = `gh pr review ${PR} --approve`;
        sink({ type: "tool", id: "t1", title: command, command, status: "complete" });
        return "done";
      },
    };
    const lines: string[] = [];
    await dispatchCommand({ ...build(), github, llm: streamed }, actor(), "C1", `rv ${PR}`, {
      reply: async (t: string) => {
        lines.push(t);
      },
    });
    expect(lines.filter((l) => l.startsWith("✅ approved"))).toHaveLength(1);
  });

  test("rv announces every gh action to the thread, even from a long heredoc command", async () => {
    const PR = "https://github.com/o/r/pull/1";
    // What the CLI really emits: a short approve, then one shell call that writes
    // the body with a heredoc and only then runs gh - past the card's 200 chars.
    const body = "the review prose ".repeat(30).trim();
    const heredoc = `cat > /tmp/r.md <<'EOF'\n${body}\nEOF\ngh pr comment ${PR} --body-file /tmp/r.md`;
    const streamed: LlmPort = {
      complete: async () => "unused",
      stream: async (_p, sink) => {
        const emit = (id: string, command: string) => {
          const title = `run: ${command}`.slice(0, 200);
          sink({ type: "tool", id, title, command, status: "in_progress" });
          sink({ type: "tool", id, title, command, status: "complete" });
        };
        emit("t1", `gh pr review ${PR} --approve 2>&1`);
        emit("t2", `gh pr review ${PR} --request-changes --body "requested changes"`);
        emit("t3", heredoc);
        return "final review text";
      },
    };
    const deps = { ...build(), llm: streamed };
    const lines: string[] = [];
    const out = await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, {
      reply: async (text: string) => {
        lines.push(text);
      },
    });

    expect(out).toBe(""); // delivered to the thread, not returned
    expect(lines[0]).toContain("reviewing");
    expect(lines).toContain(`✅ approved ${PR}`);
    expect(lines[lines.length - 1]).toBe("final review text");
    // the comment carries the body that went to GitHub, recovered from the heredoc
    expect(lines.find((l) => l.startsWith("📝"))).toBe(`📝 posted the review on ${PR}\n\n${body}`);
    // the change request is a state flip - its static marker is not echoed back
    expect(lines.find((l) => l.startsWith("⚠️"))).toBe(`⚠️ requested changes on ${PR}`);
  });

  test("rv does not announce actions that only appear as prose in a body", async () => {
    const PR = "https://github.com/o/r/pull/1";
    const streamed: LlmPort = {
      complete: async () => "unused",
      stream: async (_p, sink) => {
        const command = `gh pr comment ${PR} --body "flipping to request-changes next, and my --approve stands"`;
        sink({ type: "tool", id: "t1", title: command, command, status: "complete" });
        return "done";
      },
    };
    const lines: string[] = [];
    await dispatchCommand({ ...build(), llm: streamed }, actor(), "C1", `rv ${PR}`, {
      reply: async (text: string) => {
        lines.push(text);
      },
    });
    expect(lines.some((l) => l.startsWith(`📝 posted the review on ${PR}`))).toBe(true);
    // the prose lives in the relayed body, but must not have fired its own line
    expect(lines.some((l) => l.startsWith("⚠️"))).toBe(false);
    expect(lines.some((l) => l.startsWith("✅"))).toBe(false);
  });

  test("rv needs a PR url", async () => {
    expect(await dispatchCommand(build(), actor(), "C1", "rv")).toContain("Which PR");
  });

  test("br bombs a linked message with a full burst by default", async () => {
    const deps = build();
    const out = await dispatchCommand(deps, actor(), "C1", `br party ${LINK}`);
    expect(out).toContain("party");
    expect(slackCalls.reactions).toHaveLength(BOMB_SIZE);
  });

  test("br combines categories and honours a count", async () => {
    const deps = build();
    const out = await dispatchCommand(deps, actor(), "C1", `br money,face,negative 9 ${LINK}`);
    expect(slackCalls.reactions).toHaveLength(9);
    expect(new Set(slackCalls.reactions).size).toBe(9); // pooled, not repeated
    expect(out).toContain("money, face, negative");
  });

  test("br takes the count in either position and never exceeds the cap", async () => {
    const deps = build();
    await dispatchCommand(deps, actor(), "C1", `br 4 heart ${LINK}`);
    expect(slackCalls.reactions).toHaveLength(4);

    const deps2 = build();
    await dispatchCommand(deps2, actor(), "C1", `br heart 999 ${LINK}`);
    expect(slackCalls.reactions).toHaveLength(BOMB_SIZE);
  });

  test("br defaults to positive when no category is named", async () => {
    const deps = build();
    const out = await dispatchCommand(deps, actor(), "C1", `br ${LINK}`);
    expect(out).toContain("positive");
    expect(slackCalls.reactions).toHaveLength(BOMB_SIZE);
  });

  test("br fires the known categories and names the unknown one", async () => {
    const deps = build();
    const out = await dispatchCommand(deps, actor(), "C1", `br face,nope 5 ${LINK}`);
    expect(slackCalls.reactions).toHaveLength(5);
    expect(out).toContain("no such category: nope");
  });

  test("jrp drafts and posts a reply to the linked thread", async () => {
    const deps = build();
    const out = await dispatchCommand(deps, actor(), "C1", `jrp ${LINK}`);
    expect(out).toContain("posted");
    expect(slackCalls.posts).toHaveLength(1);
    expect(slackCalls.posts[0]).toMatchObject({ channel: "C0TEST00001", text: "an AI-drafted reply", threadTs: "1787122692.303399" });
  });

  test("rm-msg deletes the linked message", async () => {
    const deps = build();
    const out = await dispatchCommand(deps, actor(), "C1", `rm-msg ${LINK}`);
    expect(out).toContain("deleted");
    expect(slackCalls.removed).toEqual([{ channel: "C0TEST00001", ts: "1787122692.303399" }]);
  });

  test("rm-msg needs a link", async () => {
    expect(await dispatchCommand(build(), actor(), "C1", "rm-msg")).toContain("message link");
  });

  test("rm-msg explains when the message is not the bot's own", async () => {
    const deps = build();
    slackCalls.removeError = new Error("An API error occurred: cant_delete_message");
    const out = await dispatchCommand(deps, actor(), "C1", `rm-msg ${LINK}`);
    expect(out).toContain("only delete messages I posted myself");
  });

  test("rm-msg is admin-gated", async () => {
    const pal = actor({ slackId: "U9", role: "pal" });
    expect(await dispatchCommand(build(), pal, "C1", `rm-msg ${LINK}`)).toContain("access");
  });

  test("pal can review but not bomb/reply", async () => {
    const pal = actor({ slackId: "U9", role: "pal" });
    // review is pal-accessible (runs the brain), bomb/reply are admin-gated
    expect(await dispatchCommand(build(), pal, "C1", "rv https://github.com/o/r/pull/1")).toBe("drafted answer");
    expect(await dispatchCommand(build(), pal, "C1", `br party ${LINK}`)).toContain("access");
    expect(await dispatchCommand(build(), pal, "C1", `jrp ${LINK}`)).toContain("access");
  });
});

describe("owner copy of slash commands", () => {
  const slashFrom = async (deps: CommandDeps & RespondDeps, user: string, line: string) =>
    respond(deps, {
      channelId: "C1",
      slackUserId: user,
      text: `X/ev ${line}`,
      viaSlash: true,
    });

  const withUsers = () => {
    const deps = build() as CommandDeps & RespondDeps;
    deps.commandPrefix = "X/ev";
    deps.slashCommand = "/ev";
    deps.users.upsert({ slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "x", createdAt: 1 });
    deps.users.upsert({ slackId: "Upal", role: "pal", displayName: "Robin", addedBy: "x", createdAt: 1 });
    return deps;
  };

  test("the owner gets one DM thread per run, headed with who ran what", async () => {
    const deps = withUsers();
    await slashFrom(deps, "Upal", "ask what is 2+2");

    const toOwner = slackCalls.posts.filter((p) => p.channel === OWNER);
    const header = toOwner[0];
    expect(header?.text).toContain("<@Upal> ran");
    expect(header?.text).toContain("/ev ask what is 2+2");
    expect(header?.threadTs).toBeUndefined(); // the header opens the thread

    // everything else hangs off it rather than landing as its own DM
    const rest = toOwner.slice(1);
    expect(rest.map((p) => p.text)).toContain("drafted answer");
    expect(rest.every((p) => p.threadTs === "dm-1")).toBe(true);
  });

  test("two runs are two threads, not one pile", async () => {
    const deps = withUsers();
    await slashFrom(deps, "Upal", "ask what is 2+2");
    await slashFrom(deps, "Upal", "ask what is 3+3");

    const toOwner = slackCalls.posts.filter((p) => p.channel === OWNER);
    const headers = toOwner.filter((p) => p.threadTs === undefined);
    expect(headers).toHaveLength(2);
    expect(new Set(toOwner.filter((p) => p.threadTs).map((p) => p.threadTs)).size).toBe(2);
  });

  test("the owner is not copied on their own slash commands", async () => {
    const deps = withUsers();
    await slashFrom(deps, OWNER, "ask what is 2+2");
    const toOwner = slackCalls.posts.filter((p) => p.channel === OWNER);
    expect(toOwner.map((t) => t.text).some((t) => t.includes("ran"))).toBe(false);
  });

  test("trivial commands are not worth a DM", async () => {
    const deps = withUsers();
    await slashFrom(deps, "Upal", "ping");
    await slashFrom(deps, "Upal", "whoami");
    expect(slackCalls.posts.filter((p) => p.channel === OWNER)).toHaveLength(0);
  });

  test("a message command in a thread is public already, so nothing is mirrored", async () => {
    const deps = withUsers();
    await respond(deps, { channelId: "C1", slackUserId: "Upal", text: "X/ev ask hi", threadTs: "1.1" });
    expect(slackCalls.posts.filter((p) => p.channel === OWNER)).toHaveLength(0);
  });

  test("a failed owner DM never breaks the caller's command", async () => {
    const deps = withUsers();
    const good = deps.slack!.postDm;
    deps.slack = {
      ...deps.slack!,
      postDm: async (userId: string, text: string) => {
        if (userId === OWNER) throw new Error("channel_not_found");
        return good(userId, text);
      },
    };
    const res = await slashFrom(deps, "Upal", "ask what is 2+2");
    expect(res).toEqual({ kind: "reply", text: "drafted answer" });
  });
});

