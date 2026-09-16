import { describe, expect, test } from "bun:test";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createLearningsRepo } from "../../src/infrastructure/db/learningsRepo.ts";
import { createSettingsRepo } from "../../src/infrastructure/db/settingsRepo.ts";
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
  postInteractive: async (channel, text, actions, threadTs) => {
    calls.posts.push({ channel, text, threadTs });
    calls.buttons.push(...actions.map((a) => `${a.actionId}:${a.value}`));
    return { channel, ts: `interactive-${calls.posts.length}` };
  },
  settleInteractive: async (channel, ts, text) => {
    calls.settled.push({ channel, ts, text });
  },
  addReactions: async (_c, _ts, names) => {
    calls.reactions.push(...names);
    return names.length;
  },
  botUserId: async () => "UBOT",
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

  test("relearn rewords an existing learning", async () => {
    const deps = build();
    await dispatchCommand(deps, actor(), "C1", "learn staging is at old.example.com");
    const id = deps.learnings!.list()[0]!.id;

    const out = await dispatchCommand(deps, actor(), "C1", `relearn ${id} staging is at new.example.com`);
    expect(out).toContain(`#${id}`);
    expect(out).toContain("new.example.com");
    expect(deps.learnings!.list()[0]?.content).toBe("staging is at new.example.com");
    expect(deps.learnings!.list()).toHaveLength(1); // reworded, not duplicated
  });

  test("relearn needs an id that exists and something to say", async () => {
    const deps = build();
    await dispatchCommand(deps, actor(), "C1", "learn a fact");
    const id = deps.learnings!.list()[0]!.id;

    expect(await dispatchCommand(deps, actor(), "C1", "relearn")).toContain("Which one?");
    expect(await dispatchCommand(deps, actor(), "C1", "relearn notanumber hello")).toContain("Which one?");
    expect(await dispatchCommand(deps, actor(), "C1", `relearn ${id}`)).toContain("What should it say?");
    expect(await dispatchCommand(deps, actor(), "C1", "relearn 999 hello")).toContain("no learning #999");
    expect(deps.learnings!.list()[0]?.content).toBe("a fact"); // untouched throughout
  });

  test("relearn is admin-gated", async () => {
    const deps = build();
    const pal = actor({ slackId: "U0PAL0001", role: "pal" });
    expect(await dispatchCommand(deps, pal, "C1", "relearn 1 anything")).toContain("access");
  });

  test("ask calls the brain", async () => {
    const deps = build();
    expect(await dispatchCommand(deps, actor(), "C1", "ask what is 2+2")).toBe("drafted answer");
  });

  test("model reports the brain, and any per-role override", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    expect(await dispatchCommand(deps, actor(), "C1", "model")).toContain("claude-cli (opus)");

    await dispatchCommand(deps, actor(), "C1", "model pal haiku");
    const shown = await dispatchCommand(deps, actor(), "C1", "model");
    expect(shown).toContain("*pal*");
    expect(shown).toContain("haiku");
  });

  test("an admin sets a role's model; a pal cannot", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);

    const out = await dispatchCommand(deps, actor(), "C1", "model pal haiku");
    expect(out).toContain("haiku");
    expect(deps.settings.get("model:pal")).toBe("haiku");

    const pal = actor({ slackId: "U0PAL0001", role: "pal" });
    expect(await dispatchCommand(deps, pal, "C1", "model pal opus")).toContain("Only admins");
    expect(deps.settings.get("model:pal")).toBe("haiku");
    // but a pal may look
    expect(await dispatchCommand(deps, pal, "C1", "model pal")).toContain("haiku");
  });

  test("a channel can be pinned, here or by reference", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);

    const here = await dispatchCommand(deps, actor(), "C1", "model here sonnet");
    expect(here).toContain("<#C1>");
    expect(deps.settings.get("model:channel:C1")).toBe("sonnet");

    await dispatchCommand(deps, actor(), "C1", "model <#C2|general> haiku");
    expect(deps.settings.get("model:channel:C2")).toBe("haiku");

    expect(await dispatchCommand(deps, actor(), "C1", "model here")).toContain("sonnet");
    await dispatchCommand(deps, actor(), "C1", "model here default");
    expect(deps.settings.get("model:channel:C1")).toBe("");
  });

  test("a pal cannot pin a channel, and nonsense targets are refused", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    const pal = actor({ slackId: "U0PAL0001", role: "pal" });

    expect(await dispatchCommand(deps, pal, "C1", "model here haiku")).toContain("Only admins");
    expect(deps.settings.get("model:channel:C1")).toBeUndefined();
    expect(await dispatchCommand(deps, actor(), "C1", "model banana haiku")).toContain("A role or a channel");
  });

  test("model default clears the override, and junk is refused", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    await dispatchCommand(deps, actor(), "C1", "model pal haiku");

    expect(await dispatchCommand(deps, actor(), "C1", "model pal not a model")).toContain("Which model?");
    expect(deps.settings.get("model:pal")).toBe("haiku");

    await dispatchCommand(deps, actor(), "C1", "model pal default");
    expect(deps.settings.get("model:pal")).toBe("");
    expect(await dispatchCommand(deps, actor(), "C1", "model pal")).toContain("uses the default");
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
      reviewDecision: async () => undefined,
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
      reviewDecision: async () => undefined,
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
    const github: GitHubPort = {
      whoami: async () => undefined,
      reviewDecision: async () => undefined,
      approve: async () => ({ ok: true }),
    };
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

describe("reviews run on the caller's own Claude token", () => {
  const PR = "https://github.com/o/r/pull/1";
  const TOKEN = `sk-ant-oat01-${"a".repeat(48)}`;

  const withTokens = (stored?: Record<string, string>) => {
    const map = new Map(Object.entries(stored ?? {}));
    const deps = build();
    deps.settings = createSettingsRepo(db);
    deps.claudeTokens = {
      get: (id) => map.get(id),
      has: (id) => map.has(id),
      set: (id, t) => {
        map.set(id, t);
      },
      remove: (id) => {
        map.delete(id);
      },
      count: () => map.size,
    };
    let seen: string | undefined;
    deps.llm = {
      complete: async (p) => {
        seen = p.oauthToken;
        return "the review";
      },
    };
    return { deps, map, token: () => seen };
  };

  test("with a token on file, the review runs on it", async () => {
    const { deps, token } = withTokens({ [OWNER]: TOKEN });
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`);
    expect(token()).toBe(TOKEN);
  });

  test("without one the review does not run - the ask goes out with a button", async () => {
    const { deps, token } = withTokens();
    const lines: string[] = [];
    const out = await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, {
      reply: async (t: string) => {
        lines.push(t);
      },
      threadTs: "111.1",
    });

    expect(out).toBe(""); // posted into the thread, not returned
    expect(token()).toBeUndefined(); // the brain never started
    const ask = slackCalls.posts[slackCalls.posts.length - 1];
    expect(ask?.text).toContain("claude setup-token");
    expect(ask?.threadTs).toBe("111.1");
    // the button carries the command, so submitting a token resumes it
    const button = slackCalls.buttons[slackCalls.buttons.length - 1] ?? "";
    expect(button).toContain("claude_token_add");
    expect(button).toContain(PR);
  });

  test("with no button to offer, the guidance is still returned in words", async () => {
    const { deps } = withTokens();
    deps.slack = undefined;
    const out = await dispatchCommand(deps, actor(), "C1", `rv ${PR}`);
    expect(out).toContain("claude setup-token");
    expect(out).toContain("token");
  });

  test("a chat turn of theirs uses it too, and someone else's does not", async () => {
    const { deps, token } = withTokens({ [OWNER]: TOKEN });
    await dispatchCommand(deps, actor(), "C1", "ask hello");
    expect(token()).toBe(TOKEN);

    const pal = actor({ slackId: "U0PAL0003", role: "pal" });
    deps.users.upsert(pal);
    await dispatchCommand(deps, pal, "C1", "ask hello");
    expect(token()).toBeUndefined(); // falls back to the bot's own credential
  });

  test("token reports what is on file and forgets it on request", async () => {
    const { deps } = withTokens({ [OWNER]: TOKEN });
    expect(await dispatchCommand(deps, actor(), "C1", "token")).toContain("…aaaa");
    expect(await dispatchCommand(deps, actor(), "C1", "token remove")).toContain("Forgotten");
    expect(await dispatchCommand(deps, actor(), "C1", "token remove")).toContain("did not have");
    // and it never asks anyone to type one into a channel
    const asked = await dispatchCommand(deps, actor(), "C1", "token");
    expect(asked).toContain("claude setup-token");
    expect(asked).not.toContain("token <");
  });
});

describe("review fan-out cap", () => {
  const PR = "https://github.com/o/r/pull/1";

  const withBrain = () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    let system = "";
    deps.llm = {
      complete: async (p) => {
        system = p.system;
        return "the review";
      },
    };
    return { deps, sys: () => system };
  };

  test("the default cap reaches the brain's prompt", async () => {
    const { deps, sys } = withBrain();
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`);
    expect(sys()).toContain("at most 3 child agents");
  });

  test("a configured cap replaces it", async () => {
    const { deps, sys } = withBrain();
    await dispatchCommand(deps, actor(), "C1", "review-agents 5");
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`);
    expect(sys()).toContain("at most 5 child agents");
  });

  test("admins set it, anyone reads it, junk is refused", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    const pal = actor({ slackId: "U0PAL0002", role: "pal" });

    expect(await dispatchCommand(deps, pal, "C1", "review-agents 2")).toContain("Only admins");
    expect(await dispatchCommand(deps, actor(), "C1", "review-agents 0")).toContain("A number from 1");
    expect(await dispatchCommand(deps, actor(), "C1", "review-agents 99")).toContain("A number from 1");
    expect(await dispatchCommand(deps, actor(), "C1", "review-agents lots")).toContain("A number from 1");

    expect(await dispatchCommand(deps, actor(), "C1", "review-agents 2")).toContain("at most *2* child agents");
    expect(await dispatchCommand(deps, pal, "C1", "review-agents")).toContain("at most *2*");
    expect(deps.settings.get("review_agents")).toBe("2");

    await dispatchCommand(deps, actor(), "C1", "review-agents default");
    expect(await dispatchCommand(deps, pal, "C1", "review-agents")).toContain("the default");
  });

  test("a second comment is announced as a follow-up, not as the review again", async () => {
    // the late-finding case: an agent reports back after the review is posted
    const streamed: LlmPort = {
      complete: async () => "unused",
      stream: async (_p, sink) => {
        const emit = (id: string, command: string) =>
          sink({ type: "tool", id, title: command, command, status: "complete" });
        emit("t1", `gh pr comment ${PR} --body "the review"`);
        emit("t2", `gh pr comment ${PR} --body "one more thing, blocking"`);
        return "done";
      },
    };
    const deps = build();
    deps.settings = createSettingsRepo(db);
    const lines: string[] = [];
    await dispatchCommand({ ...deps, llm: streamed }, actor(), "C1", `rv ${PR}`, {
      reply: async (t: string) => {
        lines.push(t);
      },
    });
    expect(lines.some((l) => l.startsWith(`📝 posted the review on ${PR}`))).toBe(true);
    expect(lines.some((l) => l.startsWith(`📝 posted a follow-up on ${PR}`))).toBe(true);
  });

  test("a review cut off mid-run is reported as unfinished, not posted as the review", async () => {
    // the failure this exists for: the 10-minute timeout reaped a run whose
    // streamed narration then went out as if it were the finished review
    const streamed: LlmPort = {
      complete: async () => "unused",
      stream: async (_p, sink) => {
        sink({ type: "aborted", reason: "it ran out of time" });
        return "waiting on the agents";
      },
    };
    const deps = build();
    deps.settings = createSettingsRepo(db);
    deps.github = {
      whoami: async () => undefined,
      reviewDecision: async () => undefined,
      approve: async () => ({ ok: true }),
    };
    const lines: string[] = [];
    await dispatchCommand({ ...deps, llm: streamed }, actor(), "C1", `rv ${PR}`, {
      reply: async (t: string) => {
        lines.push(t);
      },
    });
    const last = lines[lines.length - 1] ?? "";
    expect(last).toContain("did not finish");
    expect(last).toContain("ran out of time");
    expect(last).toContain("how far it got");
  });

  test("an approve-after repo is not approved when the run is cut off", async () => {
    const streamed: LlmPort = {
      complete: async () => "unused",
      stream: async (_p, sink) => {
        sink({ type: "aborted", reason: "it ran out of time" });
        return "partial";
      },
    };
    const deps = build();
    deps.settings = createSettingsRepo(db);
    const approved: string[] = [];
    deps.github = {
      whoami: async () => undefined,
      reviewDecision: async () => undefined,
      approve: async (url) => {
        approved.push(url);
        return { ok: true };
      },
    };
    await dispatchCommand(deps, actor(), "C1", "review-agents default");
    await dispatchCommand(deps, actor(), "C1", "review-policy o/r after");
    await dispatchCommand({ ...deps, llm: streamed }, actor(), "C1", `rv ${PR}`, {
      reply: async () => {},
    });
    expect(approved).toEqual([]); // no review came back, so nothing is clean
  });
});

describe("per-repo review policy", () => {
  const PR = "https://github.com/acme/sql-runner/pull/905";
  const OTHER = "https://github.com/acme/acme-be/pull/1";

  const withPolicy = (decision?: string) => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    const calls: string[] = [];
    deps.github = {
      whoami: async () => undefined,
      reviewDecision: async () => decision,
      approve: async (url) => {
        calls.push(url);
        return { ok: true };
      },
    };
    let system = "";
    deps.llm = {
      complete: async (p) => {
        system = p.system;
        return "the review";
      },
    };
    const lines: string[] = [];
    const reply = async (t: string) => {
      lines.push(t);
    };
    return { deps, calls, lines, reply, sys: () => system };
  };

  test("by default a PR is approved before the review, as before", async () => {
    const { deps, calls, lines, reply } = withPolicy();
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply });
    expect(calls).toEqual([PR]);
    expect(lines[0]).toBe(`✅ approved ${PR}`);
  });

  test("on approve-after nothing is approved up front", async () => {
    const { deps, calls, lines, reply, sys } = withPolicy(undefined);
    await dispatchCommand(deps, actor(), "C1", "review-policy acme/sql-runner after");

    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply });
    expect(lines[0]).toContain("reviewing"); // no approval line first
    // and the brain is told there is no approval to lean on
    expect(sys()).toContain("NOT approved, and not yours to approve");
    // approved only once the review came back clean
    expect(calls).toEqual([PR]);
    expect(lines[lines.length - 1]).toContain("the review came back clean");
  });

  test("a blocked review is not approved at all", async () => {
    const { deps, calls, lines, reply } = withPolicy("CHANGES_REQUESTED");
    await dispatchCommand(deps, actor(), "C1", "review-policy acme/sql-runner after");

    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply });
    expect(calls).toEqual([]); // never approved
    expect(lines[lines.length - 1]).toContain("not approving");
    expect(lines[lines.length - 1]).toContain("changes are requested");
  });

  test("the policy is per repo, so others are untouched", async () => {
    const { deps, calls, lines, reply } = withPolicy();
    await dispatchCommand(deps, actor(), "C1", "review-policy acme/sql-runner after");

    await dispatchCommand(deps, actor(), "C1", `rv ${OTHER}`, { reply });
    expect(lines[0]).toBe(`✅ approved ${OTHER}`); // still approved up front
    expect(calls).toEqual([OTHER]);
  });

  test("admins set it, anyone can read it, junk is refused", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    const pal = actor({ slackId: "U0PAL0001", role: "pal" });

    expect(await dispatchCommand(deps, pal, "C1", "review-policy acme/x after")).toContain("Only admins");
    expect(await dispatchCommand(deps, actor(), "C1", "review-policy notarepo after")).toContain("Which repo?");
    expect(await dispatchCommand(deps, actor(), "C1", "review-policy acme/x sometimes")).toContain(
      "First or after?",
    );

    await dispatchCommand(deps, actor(), "C1", "review-policy acme/x after");
    expect(await dispatchCommand(deps, pal, "C1", "review-policy acme/x")).toContain("approve-after");
    expect(await dispatchCommand(deps, actor(), "C1", "review-policy")).toContain("acme/x");

    await dispatchCommand(deps, actor(), "C1", "review-policy acme/x default");
    expect(await dispatchCommand(deps, pal, "C1", "review-policy acme/x")).toContain("uses the default");
  });

  test("a PR url works as the repo argument too", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    await dispatchCommand(deps, actor(), "C1", `review-policy ${PR} after`);
    expect(deps.settings.get("review_policy:acme/sql-runner")).toBe("approve-after");
  });
});

describe("logsource", () => {
  const withSettings = () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    return deps;
  };

  test("anyone can see where I look, grafana first by default", async () => {
    const deps = withSettings();
    const pal = actor({ slackId: "U0PAL0001", role: "pal" });
    const out = await dispatchCommand(deps, pal, "C1", "logsource");
    expect(out).toContain("*grafana* → *datadog*");
    expect(out).toContain("Never: *cloudwatch*");
  });

  test("an admin reorders it", async () => {
    const deps = withSettings();
    const out = await dispatchCommand(deps, actor(), "C1", "logsource datadog,grafana");
    expect(out).toContain("*datadog* → *grafana*");
    expect(deps.settings!.get("log_sources")).toBe("datadog,grafana");
  });

  test("default puts it back", async () => {
    const deps = withSettings();
    await dispatchCommand(deps, actor(), "C1", "logsource grafana");
    await dispatchCommand(deps, actor(), "C1", "logsource default");
    expect(deps.settings!.get("log_sources")).toBe("");
    expect(await dispatchCommand(deps, actor(), "C1", "logsource")).toContain("*grafana* → *datadog*");
  });

  test("a backend I cannot reach is refused, not silently dropped", async () => {
    const deps = withSettings();
    const out = await dispatchCommand(deps, actor(), "C1", "logsource grafana,cloudwatch");
    expect(out).toContain("*cloudwatch*");
    expect(out).toContain("Pick from");
    expect(deps.settings!.get("log_sources")).toBeUndefined(); // nothing half-applied
  });

  test("a pal cannot change it", async () => {
    const deps = withSettings();
    const pal = actor({ slackId: "U0PAL0001", role: "pal" });
    expect(await dispatchCommand(deps, pal, "C1", "logsource datadog")).toContain("Only admins");
    expect(deps.settings!.get("log_sources")).toBeUndefined();
  });
});

describe("ticket", () => {
  const withSettings = () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    return deps;
  };

  test("refuses to raise one with nowhere to put it", async () => {
    const deps = withSettings();
    const out = await dispatchCommand(deps, actor(), "C1", "ticket the inbox will not load");
    expect(out).toContain("No ticket tracker is configured");
    expect(out).toContain("ticket config tracker");
  });

  test("an admin configures the sources; anyone can see them", async () => {
    const deps = withSettings();
    await dispatchCommand(deps, actor(), "C1", "ticket config tracker https://notion.so/roadmap");
    await dispatchCommand(deps, actor(), "C1", "ticket config repos acme/acme-be, acme/adhoc");
    expect(deps.settings!.get("ticket_tracker")).toBe("https://notion.so/roadmap");

    const shown = await dispatchCommand(deps, actor(), "C1", "ticket config");
    expect(shown).toContain("https://notion.so/roadmap");
    expect(shown).toContain("acme/acme-be");
  });

  test("a pal can raise one but cannot reconfigure where they go", async () => {
    const deps = withSettings();
    const pal = actor({ slackId: "U0PAL0001", role: "pal" });
    expect(await dispatchCommand(deps, pal, "C1", "ticket config tracker https://evil")).toContain("Only admins");
    expect(deps.settings!.get("ticket_tracker")).toBeUndefined();
  });

  test("raising one runs full access whoever asked, and reads the configured sources", async () => {
    const deps = withSettings();
    await dispatchCommand(deps, actor(), "C1", "ticket config tracker https://notion.so/roadmap");
    await dispatchCommand(deps, actor(), "C1", "ticket config pods https://notion.so/pods");

    let system = "";
    let policy: { skipPermissions?: boolean } | undefined;
    deps.llm = {
      complete: async (p) => {
        system = p.system;
        policy = p.policy;
        return "raised it";
      },
    };
    deps.toolPolicy = (role) => ({ skipPermissions: role === "owner" });

    const pal = actor({ slackId: "U0PAL0001", role: "pal" });
    const out = await dispatchCommand(deps, pal, "C1", "ticket surveys are not sending for Example Coffee");

    expect(out).toBe("raised it");
    expect(policy?.skipPermissions).toBe(true); // preset task, not the pal's sandbox
    expect(system).toContain("surveys are not sending for Example Coffee");
    expect(system).toContain("https://notion.so/pods");
  });

  test("needs to be told what is wrong", async () => {
    const deps = withSettings();
    await dispatchCommand(deps, actor(), "C1", "ticket config tracker https://notion.so/roadmap");
    expect(await dispatchCommand(deps, actor(), "C1", "ticket")).toContain("What is wrong?");
  });
});

