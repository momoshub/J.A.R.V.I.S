import { describe, expect, test } from "bun:test";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createLearningsRepo } from "../../src/infrastructure/db/learningsRepo.ts";
import { createSettingsRepo } from "../../src/infrastructure/db/settingsRepo.ts";
import type { ClaudeTokenPort } from "../../src/application/claudeTokens.ts";
import { createThreadSessionRepo } from "../../src/infrastructure/db/threadSessionRepo.ts";
import { createUsageRepo } from "../../src/infrastructure/db/usageRepo.ts";
import { createTurnLogRepo } from "../../src/infrastructure/db/turnLogRepo.ts";
import { createWatchRepo } from "../../src/infrastructure/db/watchRepo.ts";
import { createFollowRepo } from "../../src/infrastructure/db/followRepo.ts";
import { DEFAULT_SNUB_REPLY } from "../../src/domain/snub.ts";
import { createRunRegistry } from "../../src/application/runRegistry.ts";
import { commandLineOf, dispatchCommand, type CommandDeps, isQuietCommand } from "../../src/application/commands.ts";
import { respond, type RespondDeps } from "../../src/application/respond.ts";
import type { AllowedUser } from "../../src/domain/types.ts";
import type { LlmPort } from "../../src/application/ports.ts";
import type { SlackAdminPort, SlackMessage } from "../../src/application/slackAdmin.ts";
import type { GitHubPort } from "../../src/application/github.ts";
import { BOMB_SIZE } from "../../src/domain/emoji.ts";
import type { TotpPort } from "../../src/application/totp.ts";
import { parseTotpInput, totpCode } from "../../src/domain/totp.ts";

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
  postMenu: async () => undefined,
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

/**
 * Everyone has a Claude token, so tests about review mechanics are not all
 * about the token gate. The gate has its own describe block, with its own store.
 */
const everyoneHasToken = (): ClaudeTokenPort => ({
  get: () => `sk-ant-oat01-${"t".repeat(48)}`,
  has: () => true,
  set: () => {},
  remove: () => {},
  count: () => 1,
  list: () => [],
  asked: () => false,
  markAsked: () => {},
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
    claudeTokens: everyoneHasToken(),
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

  test("a near miss is named instead of sending them to read the list", async () => {
    // every one of these is in the real command log, answered with nothing
    const deps = build();
    expect(await dispatchCommand(deps, actor(), "C1", "hel[")).toContain("help");
    expect(await dispatchCommand(deps, actor(), "C1", "who")).toContain("whoami");
    expect(await dispatchCommand(deps, actor(), "C1", "approvel https://github.com/o/r/pull/1")).toContain(
      "approve",
    );
  });

  test("a suggestion is never a door that turns out to be locked", async () => {
    // `promote` is owner-only, so a pal who nearly types it is not pointed at it
    const out = await dispatchCommand(build(), actor({ slackId: "U3", role: "pal" }), "C1", "promot");
    expect(out).not.toContain("Did you mean");
  });

  test("a bare PR url is a review nobody bothered to name", async () => {
    const deps = build();
    const out = await dispatchCommand(deps, actor(), "C1", "https://github.com/o/r/pull/7");
    expect(out).not.toContain("do not recognise");
    // it reached `review`, which asks for a token or gets on with it
    expect(out.toLowerCase()).not.toContain("which pr");
  });

  test("`<command> help` explains it instead of running it", async () => {
    const deps = build();
    const out = await dispatchCommand(deps, actor(), "C1", "ticket help");
    expect(out).toContain("ticket");
    expect(out).toContain("needs");
    // and nothing was spawned to answer it
    expect(slackCalls.posts).toEqual([]);
  });

  test("review keeps its own, better help", async () => {
    const out = await dispatchCommand(build(), actor(), "C1", "review help");
    expect(out).toContain("review");
    expect(out).not.toContain("needs *pal* access");
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

  test("watch stores the wait instead of holding the turn open", async () => {
    const deps = build();
    const watches = createWatchRepo(db);
    const out = await dispatchCommand(
      { ...deps, watches },
      actor(),
      "C1",
      "watch --every 1m --until 30m promote be US then SG -- gh run view 1 | grep -q completed",
      { threadTs: "9.9" },
    );
    expect(out).toContain("watching");
    const [w] = watches.waiting();
    expect(w?.note).toBe("promote be US then SG");
    expect(w?.check).toBe("gh run view 1 | grep -q completed");
    expect(w?.threadTs).toBe("9.9");
    // the first check waits an interval - the thing has only just started
    expect(w?.nextAt).toBe(deps.clock() + 60_000);
  });

  test("watch pr builds its own predicate - no shell to invent", async () => {
    const deps = build();
    const watches = createWatchRepo(db);
    const out = await dispatchCommand(
      { ...deps, watches },
      actor(),
      "C1",
      "watch pr <https://github.com/o/r/pull/9|o/r#9> promote it",
      { threadTs: "9.9" },
    );
    expect(out).toContain("to be merged");
    expect(out).toContain("you can still talk to me");
    const [w] = watches.waiting();
    expect(w?.check).toContain("gh pr view 'https://github.com/o/r/pull/9'");
    expect(w?.note).toBe("promote it");
  });

  test("watch reply waits for an answer in a thread, from now on", async () => {
    const deps = build();
    const watches = createWatchRepo(db);
    const out = await dispatchCommand(
      { ...deps, watches, slackWaitScript: "/x/slack-wait.sh" },
      actor(),
      "C1",
      "watch reply https://x.slack.com/archives/C7/p1793700990971739 from <@U2> use what they say",
      { threadTs: "9.9" },
    );
    expect(out).toContain("a reply in that thread");
    expect(out).toContain("<@U2>");
    const [w] = watches.waiting();
    expect(w?.check).toContain("/x/slack-wait.sh 'C7' '1793700990.971739'");
    expect(w?.check).toContain("'U2'");
  });

  test("a named wait with the wrong sort of target is refused", async () => {
    const out = await dispatchCommand(
      { ...build(), watches: createWatchRepo(db) },
      actor(),
      "C1",
      "watch pr the-big-one do it",
      { threadTs: "9.9" },
    );
    expect(out).toContain("needs a GitHub pull request url");
  });

  test("a watch needs a thread to come back to", async () => {
    const out = await dispatchCommand(
      { ...build(), watches: createWatchRepo(db) },
      actor(),
      "C1",
      "watch do the thing -- true",
    );
    expect(out).toContain("belongs to a thread");
  });

  test("setting a shell check on a timer is admin and up", async () => {
    const out = await dispatchCommand(
      { ...build(), watches: createWatchRepo(db) },
      actor({ slackId: "U3", role: "pal" }),
      "C1",
      "watch do it -- true",
      { threadTs: "9.9" },
    );
    expect(out).toContain("needs *admin*");
  });

  test("watch cancel ends the ones on this thread", async () => {
    const deps = build();
    const watches = createWatchRepo(db);
    const d = { ...deps, watches };
    await dispatchCommand(d, actor(), "C1", "watch promote it -- true", { threadTs: "9.9" });
    const out = await dispatchCommand(d, actor(), "C1", "watch cancel", { threadTs: "9.9" });
    expect(out).toContain("stopped 1 watch");
    expect(watches.waiting()).toHaveLength(0);
  });

  test("watch list says what it is waiting for, or that it is not", async () => {
    const deps = build();
    const watches = createWatchRepo(db);
    expect(await dispatchCommand({ ...deps, watches }, actor(), "C1", "watch list")).toContain(
      "not waiting for anything",
    );
    await dispatchCommand({ ...deps, watches }, actor(), "C1", "watch promote it -- true", { threadTs: "9.9" });
    expect(await dispatchCommand({ ...deps, watches }, actor(), "C1", "watch list")).toContain("every 1m");
  });

  test("mindful leads with what is stuck, not with what is busy", async () => {
    const deps = build();
    const turns = createTurnLogRepo(db);
    turns.add({
      runId: "r1", channelId: "C9", threadTs: "5.5", slackUserId: "U7", kind: "chat",
      request: "why is form-analytics slow", outcome: "failed", error: "disk I/O error",
      startedAt: 1, endedAt: 2,
    });
    const out = await dispatchCommand({ ...deps, turns }, actor(), "C1", "mindful");
    expect(out).toContain("stuck");
    expect(out).toContain("why is form-analytics slow");
    expect(out).toContain("disk I/O error");
    expect(out).toContain("mindful continue"); // tells you what to do about it
  });

  test("mindful is admin and up only - it quotes people across every channel", async () => {
    const out = await dispatchCommand(build(), actor({ slackId: "U3", role: "pal" }), "C1", "mindful");
    expect(out).toContain("needs *admin*");
  });

  test("mindful continue runs the dead turn again, as whoever asked for it", async () => {
    const deps = build();
    const turns = createTurnLogRepo(db);
    turns.add({
      runId: "r1", channelId: "C9", threadTs: "1793700990.971739", slackUserId: "U7", kind: "chat",
      request: "fix the view", outcome: "failed", error: "boom", startedAt: 1, endedAt: 2,
    });
    const ran: unknown[] = [];
    const out = await dispatchCommand(
      { ...deps, turns, runTurn: async (r) => void ran.push(r) },
      actor(),
      "C1",
      "mindful continue https://x.slack.com/archives/C9/p1793700990971739",
    );
    expect(ran).toEqual([
      { channelId: "C9", threadTs: "1793700990.971739", slackUserId: "U7", text: "fix the view" },
    ]);
    expect(out).toContain("<@U7>");
  });

  test("mindful continue refuses a thread that is fine, rather than repeating work", async () => {
    const deps = build();
    const turns = createTurnLogRepo(db);
    turns.add({
      runId: "r", channelId: "C9", threadTs: "1793700990.971739", slackUserId: "U7", kind: "chat",
      request: "done already", outcome: "ok", error: "", startedAt: 1, endedAt: 2,
    });
    const ran: unknown[] = [];
    const out = await dispatchCommand(
      { ...deps, turns, runTurn: async (r) => void ran.push(r) },
      actor(),
      "C1",
      "mindful continue https://x.slack.com/archives/C9/p1793700990971739",
    );
    expect(ran).toHaveLength(0);
    expect(out).toContain("finished fine");
  });

  test("mindful reply nudges a thread, and says nothing is guaranteed", async () => {
    const ran: { text: string }[] = [];
    const out = await dispatchCommand(
      { ...build(), runTurn: async (r) => void ran.push(r) },
      actor(),
      "C1",
      "mindful reply https://x.slack.com/archives/C9/p1793700990971739",
    );
    expect(ran[0]?.text).toContain("reply only if you have something");
    expect(out).toContain("only if it has something");
  });

  test("mindful reply carries what you told it to say", async () => {
    const ran: { text: string }[] = [];
    await dispatchCommand(
      { ...build(), runTurn: async (r) => void ran.push(r) },
      actor(),
      "C1",
      "mindful reply https://x.slack.com/archives/C9/p1793700990971739 ask Bea about the mirror",
    );
    expect(ran[0]?.text).toBe("ask Bea about the mirror");
  });

  test("note with a page url updates that page instead of making another", async () => {
    const PAGE = "https://notion.so/Runbook-1a2b3c4d5e6f7081920a1b2c3d4e5f60";
    const deps = build();
    deps.settings = createSettingsRepo(db);
    deps.settings.set("notion_parent", "https://notion.so/parent");
    let system = "";
    const llm: LlmPort = {
      complete: async (p) => {
        system = p.system;
        return PAGE;
      },
    };
    await dispatchCommand({ ...deps, llm }, actor(), "C1", `note /tmp/doc.md <${PAGE}|Runbook>`);
    expect(system).toContain("updating a document in Notion");
    expect(system).toContain(PAGE);
    expect(system).toContain("do NOT create a new page");
  });

  test("note with no page url still just publishes one", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    deps.settings.set("notion_parent", "https://notion.so/parent");
    let system = "";
    const llm: LlmPort = { complete: async (p) => ((system = p.system), "ok") };
    await dispatchCommand({ ...deps, llm }, actor(), "C1", "note /tmp/doc.md Deployment Runbook");
    expect(system).toContain("publishing a document into Notion");
    expect(system).toContain("Title: Deployment Runbook");
  });

  test("an update does not need a configured parent - it knows where it is going", async () => {
    const PAGE = "1a2b3c4d5e6f7081920a1b2c3d4e5f60";
    const deps = build();
    deps.settings = createSettingsRepo(db); // no notion_parent set
    let system = "";
    const llm: LlmPort = { complete: async (p) => ((system = p.system), "ok") };
    const out = await dispatchCommand({ ...deps, llm }, actor(), "C1", `note /tmp/doc.md --into ${PAGE}`);
    expect(out).not.toContain("nowhere to put it");
    expect(system).toContain("updating a document in Notion");
  });

  test("a target that is not a page is refused rather than published somewhere", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    deps.settings.set("notion_parent", "https://notion.so/parent");
    const out = await dispatchCommand(deps, actor(), "C1", "note /tmp/doc.md --into the-runbook");
    expect(out).toContain("not a Notion page");
  });

  test("btw answers from the thread without joining it", async () => {
    const deps = build();
    deps.messages.append(
      { channelId: "C1", slackUserId: "U1", role: "user", content: "we are migrating the orders table", slackTs: "1.1", threadTs: "9.9" },
      1,
    );
    let seen: { system: string; messages: { content: string }[]; policy?: { disallowedTools?: readonly string[] }; session?: unknown } | undefined;
    const llm: LlmPort = {
      complete: async (p) => {
        seen = p as never;
        return "short answer";
      },
    };
    const out = await dispatchCommand({ ...deps, llm }, actor(), "C1", "btw what is a CTE again?", {
      threadTs: "9.9",
    });

    expect(out).toBe("short answer");
    // it READ the thread
    expect(seen?.messages.some((m) => m.content.includes("migrating the orders table"))).toBe(true);
    expect(seen?.messages[seen.messages.length - 1]?.content).toBe("what is a CTE again?");
    // and did not join it: no session to resume, nothing written back
    expect(seen?.session).toBeUndefined();
    expect(deps.messages.recentForThread("C1", "9.9", 10)).toHaveLength(1);
  });

  test("btw has no tools, by denial rather than by an allow-list", async () => {
    // an allow-list pre-approves what is on it and does not refuse what is off
    // it, measured against the CLI - so an empty one would deny nothing
    const deps = build();
    let policy: { disallowedTools?: readonly string[]; skipPermissions?: boolean } | undefined;
    const llm: LlmPort = {
      complete: async (p) => {
        policy = p.policy as never;
        return "answer";
      },
    };
    await dispatchCommand({ ...deps, llm }, actor(), "C1", "btw anything");
    expect(policy?.skipPermissions).toBe(false);
    expect(policy?.disallowedTools).toContain("Bash");
    expect(policy?.disallowedTools).toContain("Read");
    expect(policy?.disallowedTools).toContain("WebFetch");
  });

  test("btw with no question asks for one rather than spending a turn", async () => {
    const out = await dispatchCommand(build(), actor(), "C1", "btw");
    expect(out).toContain("side question");
  });

  test("spend says who spent it and on what, at list price", async () => {
    const deps = build();
    const usage = createUsageRepo(db);
    const add = (slackUserId: string, kind: string, costUsd: number) =>
      usage.add(
        {
          slackUserId,
          kind,
          channelId: "C1",
          model: "claude-opus-5-5",
          payer: "bot",
          inputTokens: 1,
          outputTokens: 1,
          cacheRead: 0,
          cacheWrite: 0,
          costUsd,
          durationMs: 1000,
        },
        40, // deps.clock() is 42, so this is inside any window
      );
    add(OWNER, "review", 3);
    add("U3", "chat", 1);
    deps.users.upsert(actor());

    const out = await dispatchCommand({ ...deps, usage }, actor(), "C1", "spend");
    expect(out).toContain("list price");
    expect(out).toContain("$4.00");
    expect(out).toContain("review");
    expect(out).toContain("Kai"); // the owner's display name, not a raw id
  });

  test("spend without a recorder says so instead of reporting zero", async () => {
    const out = await dispatchCommand(build(), actor(), "C1", "spend");
    expect(out).toContain("not recording");
  });

  test("approve approves, with no brain and no review", async () => {
    // five attempts in the real log at `approve <pr-url>`, all of them answered
    // with "I do not recognise `approve`"
    const PR = "https://github.com/o/r/pull/1";
    const approved: string[] = [];
    const github: GitHubPort = {
      whoami: async () => ({ login: "kai-at-acme", name: "Kai" }),
      reviewDecision: async () => undefined,
      approve: async (url) => {
        approved.push(url);
        return { ok: true };
      },
    };
    const brainRan = { yes: false };
    const watch: LlmPort = {
      complete: async () => {
        brainRan.yes = true;
        return "";
      },
    };
    const out = await dispatchCommand(
      { ...build(), github, llm: watch },
      actor(),
      "C1",
      `approve <${PR}|o/r#1>`,
    );
    expect(approved).toEqual([PR]);
    expect(brainRan.yes).toBe(false);
    expect(out).toContain("approved");
    expect(out).toContain("nobody read it"); // it says what it did not do
  });

  test("approve will not go round a repo that approves only after a clean review", async () => {
    const PR = "https://github.com/o/strict/pull/2";
    const approved: string[] = [];
    const github: GitHubPort = {
      whoami: async () => ({ login: "kai", name: "Kai" }),
      reviewDecision: async () => undefined,
      approve: async (url) => {
        approved.push(url);
        return { ok: true };
      },
    };
    const deps = { ...build(), github };
    deps.settings = createSettingsRepo(db);
    deps.settings.set("review_policy:o/strict", "approve-after");
    const out = await dispatchCommand(deps, actor(), "C1", `approve ${PR}`);
    expect(approved).toEqual([]);
    expect(out).toContain("only after a clean review");
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

describe("stop command", () => {
  const tracked = (runs: ReturnType<typeof createRunRegistry>, over: Record<string, unknown> = {}) =>
    runs.track({
      id: "r1",
      key: "C1:900.1",
      channelId: "C1",
      threadTs: "900.1",
      actor: OWNER,
      what: "the long one",
      startedAt: 0,
      ...over,
    });

  test("stops the turn running in this thread", async () => {
    const deps = build();
    const runs = createRunRegistry();
    deps.runs = runs;
    const t = tracked(runs);
    t.running();

    const out = await dispatchCommand(deps, actor(), "C1", "stop", { threadTs: "900.1" });
    expect(out).toContain("stopped");
    expect(out).toContain("the long one");
    expect(t.signal.aborted).toBe(true);
  });

  test("says plainly when there is nothing to stop", async () => {
    // "nothing is running" and "I could not stop it" read very differently when
    // you are watching something misbehave
    const deps = build();
    deps.runs = createRunRegistry();
    expect(await dispatchCommand(deps, actor(), "C1", "stop", { threadTs: "900.1" })).toContain(
      "Nothing is running",
    );
  });

  test("someone else's turn takes an admin", async () => {
    const deps = build();
    const runs = createRunRegistry();
    deps.runs = runs;
    const t = tracked(runs, { actor: "U-other" });
    t.running();

    const pal = actor({ slackId: "U0PAL0007", role: "pal" });
    deps.users.upsert(pal);
    const refused = await dispatchCommand(deps, pal, "C1", "stop", { threadTs: "900.1" });
    expect(refused).toContain("Only they or an admin");
    expect(t.signal.aborted).toBe(false);

    await dispatchCommand(deps, actor(), "C1", "stop", { threadTs: "900.1" });
    expect(t.signal.aborted).toBe(true);
  });

  test("outside a thread there is nothing it could mean", async () => {
    const deps = build();
    deps.runs = createRunRegistry();
    expect(await dispatchCommand(deps, actor(), "C1", "stop")).toContain("inside a thread");
  });
});

describe("session command", () => {
  test("reports, resets, and is only switchable by admins", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    deps.threadSessions = createThreadSessionRepo(db);
    deps.threadSessionsOn = () => deps.settings!.get("thread_sessions") !== "off";
    const pal = actor({ slackId: "U0PAL0004", role: "pal" });
    deps.users.upsert(pal);

    const inThread = { threadTs: "900.1" };
    expect(await dispatchCommand(deps, actor(), "C1", "session", inThread)).toContain("No session bound");

    deps.threadSessions.claim("C1", "900.1", "sandbox", "sess-1", "900.1", 1, "hash");
    expect(await dispatchCommand(deps, pal, "C1", "session", inThread)).toContain("1 turn in");

    expect(await dispatchCommand(deps, pal, "C1", "session reset", inThread)).toContain("Dropped it");
    expect(deps.threadSessions.find("C1", "900.1", "sandbox")).toBeUndefined();

    expect(await dispatchCommand(deps, pal, "C1", "session off", inThread)).toContain("Only admins");
    expect(await dispatchCommand(deps, actor(), "C1", "session off", inThread)).toContain("off");
    expect(deps.settings.get("thread_sessions")).toBe("off");
    expect(await dispatchCommand(deps, actor(), "C1", "session", inThread)).toContain("off");

    await dispatchCommand(deps, actor(), "C1", "session on", inThread);
    expect(deps.settings.get("thread_sessions")).toBe("");
  });

  test("outside a thread there is nothing to report", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    deps.threadSessions = createThreadSessionRepo(db);
    expect(await dispatchCommand(deps, actor(), "C1", "session")).toContain("inside a thread");
  });
});

describe("reviews run on the caller's own Claude token", () => {
  const PR = "https://github.com/o/r/pull/1";
  const TOKEN = `sk-ant-oat01-${"a".repeat(48)}`;

  const withTokens = (stored?: Record<string, string>) => {
    const map = new Map(Object.entries(stored ?? {}));
    const asks = new Set<string>();
    const deps = build();
    deps.settings = createSettingsRepo(db);
    deps.claudeTokens = {
      get: (id) => map.get(id),
      has: (id) => map.has(id),
      set: (id, t) => {
        map.set(id, t);
        asks.delete(id);
      },
      remove: (id) => {
        map.delete(id);
        asks.delete(id);
      },
      count: () => map.size,
      list: () => [...map.keys()].map((slackId) => ({ slackId, updatedAt: 0 })),
      asked: (id) => asks.has(id),
      markAsked: (id) => {
        asks.add(id);
      },
    };
    let seen: string | undefined;
    let system = "";
    deps.llm = {
      complete: async (p) => {
        seen = p.oauthToken;
        system = p.system;
        return "the review";
      },
    };
    return { deps, map, token: () => seen, sys: () => system };
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

  test("nobody is asked twice - the second attempt points at the box they have", async () => {
    const { deps } = withTokens();
    const reply = async () => {};
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply });
    const asks = slackCalls.posts.filter((p) => p.text.includes("claude setup-token")).length;
    expect(asks).toBe(1);

    const again = await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply });
    expect(again).toContain("still waiting");
    // and no second walkthrough went into the channel
    expect(slackCalls.posts.filter((p) => p.text.includes("claude setup-token")).length).toBe(1);

    // answering resets it, so removing a token later earns a fresh ask
    deps.claudeTokens!.set(OWNER, TOKEN);
    deps.claudeTokens!.remove(OWNER);
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply });
    expect(slackCalls.posts.filter((p) => p.text.includes("claude setup-token")).length).toBe(2);
  });

  test("with no token store at all it refuses rather than using the bot's own", async () => {
    const { deps, token } = withTokens();
    deps.claudeTokens = undefined;
    const out = await dispatchCommand(deps, actor(), "C1", `rv ${PR}`);
    expect(out).toContain("only ever runs on the caller's own");
    expect(token()).toBeUndefined(); // the brain never started
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

  test("read is a tool: no reply wired means the content comes back", async () => {
    // it is one step of a larger job, so the brain gets the document to work
    // with rather than the thread getting the document posted into it
    const { deps } = withTokens({ [OWNER]: TOKEN });
    deps.llm = { complete: async () => "the page says X" };
    const lines: string[] = [];
    // no `reply` - the shape the command bridge now uses for tool-like commands
    const out = await dispatchCommand(deps, actor(), "C1", "read https://x/p1");
    expect(out).toBe("the page says X");
    expect(lines).toHaveLength(0);
  });

  test("and is marked quiet, so the bridge waits for it instead of posting", () => {
    expect(isQuietCommand("read https://x/p1")).toBe(true);
    expect(isQuietCommand("summarise https://x/p1")).toBe(true);
    // the long-running announcers stay as they are: nobody is holding a line
    // open for a review, and it reports into the thread itself
    expect(isQuietCommand("review https://github.com/o/r/pull/1")).toBe(false);
    expect(isQuietCommand("ticket something broke")).toBe(false);
    expect(isQuietCommand("investigate why")).toBe(false);
  });

  test("watch is quiet too: its confirmation goes back to the brain, not the thread", () => {
    expect(isQuietCommand("watch checks https://github.com/o/r/pull/1 post the result")).toBe(true);
    expect(isQuietCommand("watch list")).toBe(true);
  });

  test("any command's help is quiet, so the brain reads it without posting it", () => {
    expect(isQuietCommand("bomb help")).toBe(true);
    expect(isQuietCommand("review help")).toBe(true);
    expect(isQuietCommand("ticket --help")).toBe(true);
    expect(isQuietCommand("help")).toBe(true);
    expect(isQuietCommand("ticket help me the page is broken")).toBe(false);
  });

  test("read's floor is configurable, and a refusal says who can run it", async () => {
    // owner-only made it useless for the case it exists for: a teammate asking
    // it to follow a document the team shares
    const { deps } = withTokens({ [OWNER]: TOKEN });
    const pal = actor({ slackId: "U0PAL77", role: "pal" });
    deps.users.upsert(pal);
    const link = "https://app.notion.com/p/handbook-1a2b3c4d5e6f7081920a1b2c3d4e5f61";

    const refused = await dispatchCommand(deps, pal, "C1", `read ${link}`);
    expect(refused).toContain("*admin* and above"); // the default floor
    expect(refused).toContain("Ask someone at that level");
    expect(refused).toContain("paste the content here");

    // an admin may open it up, and then the pal gets through
    expect(await dispatchCommand(deps, pal, "C1", "read access pal")).toContain("Only admins");
    expect(await dispatchCommand(deps, actor(), "C1", "read access pal")).toContain("open to *pal*");
    expect(deps.settings!.get("read_min_role")).toBe("pal");
    expect(await dispatchCommand(deps, pal, "C1", "read")).toContain("Read what?");
  });

  test("read runs on the host login, and is open to admins by default", async () => {
    // it reads with the authorising human's Slack access, so anyone who can run
    // it can read anything that person can
    const { deps } = withTokens({ [OWNER]: TOKEN });
    let seen: { useHostLogin?: boolean; system?: string } = {};
    deps.llm = {
      complete: async (p) => {
        seen = { useHostLogin: p.useHostLogin, system: p.system };
        return "here is the gist";
      },
    };
    const out = await dispatchCommand(deps, actor(), "C1", "read https://x.slack.com/archives/C1/p1792422356053559 just the decisions");
    expect(seen.useHostLogin).toBe(true);
    expect(seen.system).toContain("just the decisions");
    expect(out).toBe("here is the gist");

    // an admin is above the default floor, so it reaches the brain
    const admin = actor({ slackId: "U0ADMIN99", role: "admin" });
    deps.users.upsert(admin);
    await dispatchCommand(deps, admin, "C1", "read https://x.slack.com/archives/C1/p1");
    expect(seen.useHostLogin).toBe(true);
  });

  test("read needs something to read", async () => {
    const { deps } = withTokens({ [OWNER]: TOKEN });
    expect(await dispatchCommand(deps, actor(), "C1", "read")).toContain("Read what?");
  });

  test("investigate runs on the host login, where the connectors are", async () => {
    // Datadog and its RUM data come from the account's connectors, which a
    // setup token - the bot's or a caller's - carries none of
    const { deps } = withTokens({ [OWNER]: TOKEN });
    let seen: { oauthToken?: string; useHostLogin?: boolean; system?: string } = {};
    deps.llm = {
      complete: async (p) => {
        seen = { oauthToken: p.oauthToken, useHostLogin: p.useHostLogin, system: p.system };
        return "here is what happened";
      },
    };
    const out = await dispatchCommand(deps, actor(), "C1", "investigate why did /home crash");
    expect(seen.useHostLogin).toBe(true);
    expect(seen.oauthToken).toBeUndefined();
    expect(seen.system).toContain("why did /home crash");
    expect(out).toBe("here is what happened");
  });

  test("investigate needs a question, and somewhere to look", async () => {
    const { deps } = withTokens({ [OWNER]: TOKEN });
    expect(await dispatchCommand(deps, actor(), "C1", "investigate")).toContain("What should I look into?");

    deps.settings!.set("log_sources", "");
    const noSources = { ...deps, settings: { ...deps.settings!, get: () => "" } } as typeof deps;
    expect(await dispatchCommand(noSources, actor(), "C1", "investigate why")).not.toContain("What should I look into?");
  });

  test("fanout hands the job to the coordinator prompt", async () => {
    const { deps } = withTokens({ [OWNER]: TOKEN });
    let system = "";
    deps.llm = {
      complete: async (p) => {
        system = p.system ?? "";
        return "two workers done";
      },
    };
    const out = await dispatchCommand(deps, actor(), "C1", "fanout fix the flaky login tests");
    expect(system).toContain("fix the flaky login tests");
    expect(system).toContain("orca worktree create");
    expect(out).toBe("two workers done");
  });

  test("fanout needs a job", async () => {
    const { deps } = withTokens({ [OWNER]: TOKEN });
    expect(await dispatchCommand(deps, actor(), "C1", "fanout")).toContain("What should the agents work on?");
  });

  test("fanout is not open to a pal, since workers bill the host login", async () => {
    const { deps } = withTokens({ [OWNER]: TOKEN });
    let called = false;
    deps.llm = { complete: async () => { called = true; return "x"; } };
    const pal = actor({ slackId: "U0PAL0001", role: "pal" });
    deps.users.upsert(pal);
    await dispatchCommand(deps, pal, "C1", "fanout do things");
    expect(called).toBe(false);
  });

  test("a ticket runs on the host login, never on a setup token", async () => {
    // tickets need Notion, and no setup token - the bot's or a caller's - carries
    // any claude.ai connector authorisation
    const { deps } = withTokens({ [OWNER]: TOKEN });
    deps.settings!.set("ticket_tracker", "https://notion.so/tracker");
    let seen: { oauthToken?: string; useHostLogin?: boolean } = {};
    deps.llm = {
      complete: async (p) => {
        seen = { oauthToken: p.oauthToken, useHostLogin: p.useHostLogin };
        return "raised";
      },
    };
    await dispatchCommand(deps, actor(), "C1", "ticket the webhook retries are dropping");
    expect(seen.useHostLogin).toBe(true);
    expect(seen.oauthToken).toBeUndefined();
  });

  test("a lapsed host login is named, not reported as a failed ticket", async () => {
    const { deps } = withTokens({ [OWNER]: TOKEN });
    deps.settings!.set("ticket_tracker", "https://notion.so/tracker");
    deps.llm = {
      complete: async () => {
        throw new Error("Failed to authenticate. API Error: 401 OAuth access token is invalid.");
      },
    };
    const lines: string[] = [];
    await dispatchCommand(deps, actor(), "C1", "ticket something broke", {
      reply: async (t: string) => {
        lines.push(t);
      },
    });
    const last = lines[lines.length - 1] ?? "";
    expect(last).toContain("login on my host has lapsed");
    expect(last).toContain("sign in again");
  });

  test("a word that is not a PR never reaches the brain", async () => {
    // the bug: `review help` ran a full review of a pull request called "help"
    const { deps, token } = withTokens({ [OWNER]: TOKEN });
    for (const line of ["rv the", "rv acme-be", "rv please have a look"]) {
      const out = await dispatchCommand(deps, actor(), "C1", line);
      expect(out).toContain("Which PR?");
    }
    expect(token()).toBeUndefined(); // nothing expensive was spawned
  });

  test("review help explains itself instead of reviewing something called help", async () => {
    const { deps, token } = withTokens({ [OWNER]: TOKEN });
    const out = await dispatchCommand(deps, actor(), "C1", "rv help");
    expect(out).toContain("How I review a PR");
    expect(out).toContain("your own");
    expect(token()).toBeUndefined();

    const prompt = await dispatchCommand(deps, actor(), "C1", "rv prompt");
    expect(prompt).toContain("doing a real code review");
    expect(token()).toBeUndefined();
  });

  test("a shorthand the brain can resolve is still allowed through", async () => {
    const { deps, sys } = withTokens({ [OWNER]: TOKEN });
    await dispatchCommand(deps, actor(), "C1", "rv acme/acme-be#13600");
    expect(sys()).toContain("acme/acme-be#13600");
  });

  test("token who lists the people who gave me one, and is admin-only", async () => {
    // it used to answer with the usage line: the catch-all sat above this branch
    const { deps } = withTokens({ [OWNER]: TOKEN });
    const out = await dispatchCommand(deps, actor(), "C1", "token who");
    expect(out).toContain(`<@${OWNER}>`);
    expect(out).toContain("1 person has");
    expect(out).not.toContain("to add or replace one");
    expect(out).not.toContain(TOKEN);

    const pal = actor({ slackId: "U0PAL0005", role: "pal" });
    deps.users.upsert(pal);
    expect(await dispatchCommand(deps, pal, "C1", "token who")).toContain("Only admins");
  });

  test("token who says plainly when nobody has one", async () => {
    const { deps } = withTokens();
    const out = await dispatchCommand(deps, actor(), "C1", "token list");
    expect(out).toContain("Nobody has given me a token yet");
    expect(out).toContain("nobody can run a review");
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

  test("words typed next to the url become guidance, not a review target", async () => {
    const { deps, sys } = withBrain();
    const lines: string[] = [];
    await dispatchCommand(deps, actor(), "C1", `rv ${PR} focus on the sql migration`, {
      reply: async (t: string) => {
        lines.push(t);
      },
    });
    expect(sys()).toContain("focus on the sql migration");
    expect(sys()).toContain("What the person asking wants you to look at");
    // the note is not mistaken for a second PR
    expect(sys()).toContain(PR);
    expect(lines.some((l) => l.includes("_looking at: focus on the sql migration_"))).toBe(true);
  });

  test("no note, no guidance section", async () => {
    const { deps, sys } = withBrain();
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`);
    expect(sys()).not.toContain("in their words");
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

  test("--policy after holds the approval back for one run, without writing it down", async () => {
    const { deps, calls, lines, reply } = withPolicy(undefined);
    await dispatchCommand(deps, actor(), "C1", `rv ${OTHER} --policy after`, { reply });

    expect(lines[0]).toContain("reviewing"); // no approval up front
    expect(lines[0]).toContain("approve-after");
    expect(lines[lines.length - 1]).toContain("the review came back clean");
    expect(calls).toEqual([OTHER]); // approved only after
    // and the repo is still on its own policy for the next one
    expect(deps.settings!.get("review_policy:acme/acme-be")).toBeUndefined();
  });

  test("the flag is not mistaken for a PR or for the steering note", async () => {
    const { deps, lines, reply, sys } = withPolicy(undefined);
    await dispatchCommand(deps, actor(), "C1", `rv ${OTHER} --policy after check the migration`, { reply });
    expect(sys()).toContain("check the migration");
    expect(sys()).not.toContain("--policy");
    expect(lines.some((l) => l.includes("_looking at: check the migration_"))).toBe(true);
  });

  test("loosening an approve-after repo takes an admin; tightening does not", async () => {
    const { deps, calls, reply } = withPolicy(undefined);
    await dispatchCommand(deps, actor(), "C1", "review-policy acme/sql-runner after");
    const pal = actor({ slackId: "U0PAL0006", role: "pal" });
    deps.users.upsert(pal);

    // a pal cannot overrule the admin decision that this repo waits for a review
    const refused = await dispatchCommand(deps, pal, "C1", `rv ${PR} --policy first`, { reply });
    expect(refused).toContain("only an admin");
    expect(calls).toEqual([]); // nothing approved

    // but anyone may ask for the stricter run
    await dispatchCommand(deps, pal, "C1", `rv ${OTHER} --policy after`, { reply });
    expect(calls).toEqual([OTHER]); // approved after the review, not before
  });

  test("several PRs share the run's policy, and the note is not eaten", async () => {
    const { deps, calls, lines, reply, sys } = withPolicy(undefined);
    const second = "https://github.com/acme/acme-be/pull/2";
    await dispatchCommand(deps, actor(), "C1", `rv ${OTHER} --policy after ${second} check the migration`, {
      reply,
    });
    expect(calls).toEqual([OTHER, second]); // both approved only after the review
    expect(lines[0]).toContain(OTHER);
    expect(lines[0]).toContain(second);
    expect(sys()).toContain("check the migration");
  });

  test("a note that merely looks like the flag does not stop the review", async () => {
    const { deps, sys, lines, reply } = withPolicy(undefined);
    await dispatchCommand(deps, actor(), "C1", `rv ${OTHER} check the policy:handler code`, { reply });
    expect(sys()).toContain("check the policy:handler code");
    expect(lines.some((l) => l.includes("is not a policy"))).toBe(false);
  });

  test("a policy that is not one is refused rather than quietly ignored", async () => {
    const { deps } = withPolicy(undefined);
    expect(await dispatchCommand(deps, actor(), "C1", `rv ${PR} --policy sometimes`)).toContain(
      "is not a policy",
    );
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

  test("an author on approve-after is reviewed first, whatever the repo is on", async () => {
    const { deps, calls, lines, reply } = withPolicy(undefined);
    deps.github!.author = async (url) => (url === PR ? "app/morcela-agent" : "kai");
    // the API spelling of the same app, so either one sets it
    await dispatchCommand(deps, actor(), "C1", "review-policy author:morcela-agent[bot] after");

    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply });
    expect(lines[0]).toContain("reviewing"); // no approval up front
    expect(calls).toEqual([PR]); // approved only once the review came back clean

    // someone else's PR is still on the repo's policy
    lines.length = 0;
    await dispatchCommand(deps, actor(), "C1", `rv ${OTHER}`, { reply });
    expect(lines[0]).toBe(`✅ approved ${OTHER}`);
  });

  test("an author hold blocks a bare approve and a pal's --policy first", async () => {
    const { deps, calls, reply } = withPolicy(undefined);
    deps.github!.author = async () => "app/morcela-agent";
    await dispatchCommand(deps, actor(), "C1", "review-policy @morcela-agent after");
    const pal = actor({ slackId: "U0PAL0007", role: "pal" });
    deps.users.upsert(pal);

    expect(await dispatchCommand(deps, actor(), "C1", `approve ${PR}`)).toContain("only after a clean review");
    expect(await dispatchCommand(deps, pal, "C1", `rv ${PR} --policy first`, { reply })).toContain("only an admin");
    expect(calls).toEqual([]);
  });

  test("author policies are listed, read back, and reset", async () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    await dispatchCommand(deps, actor(), "C1", "review-policy author:app/morcela-agent after");
    expect(deps.settings.get("review_policy_author:morcela-agent")).toBe("approve-after");
    expect(await dispatchCommand(deps, actor(), "C1", "review-policy")).toContain("author `morcela-agent`");
    expect(await dispatchCommand(deps, actor(), "C1", "review-policy author:morcela-agent")).toContain(
      "approve-after",
    );
    expect(await dispatchCommand(deps, actor(), "C1", "review-policy author:-bad-")).toContain("Which author?");
    await dispatchCommand(deps, actor(), "C1", "review-policy author:morcela-agent default");
    expect(await dispatchCommand(deps, actor(), "C1", "review-policy author:morcela-agent")).toContain(
      "uses the default",
    );
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


describe("2fa", () => {
  /** RFC 6238's seed, so an expected code can be written down rather than guessed. */
  const SEED = "otpauth://totp/acme:demo%40acme.io?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=acme";

  const fakeTotp = (): TotpPort => {
    const rows = new Map<string, { uri: string; account?: string; addedBy: string; updatedAt: number }>();
    return {
      get: (label) => {
        const row = rows.get(label);
        return row ? parseTotpInput(row.uri) : undefined;
      },
      has: (label) => rows.has(label),
      set: (label, uri, addedBy, account) => {
        rows.set(label, { uri, account, addedBy, updatedAt: 0 });
      },
      remove: (label) => rows.delete(label),
      list: () =>
        [...rows.entries()].map(([label, r]) => ({
          label,
          account: r.account,
          addedBy: r.addedBy,
          updatedAt: r.updatedAt,
        })),
    };
  };

  const withTotp = (at: number): CommandDeps & { totp: TotpPort } => {
    const deps = { ...build(), totp: fakeTotp(), clock: () => at };
    return deps as CommandDeps & { totp: TotpPort };
  };

  test("says so plainly when there is no store wired up", async () => {
    const deps = build();
    expect(await dispatchCommand(deps, actor(), "C1", "2fa demo")).toContain("not wired up");
  });

  test("a pal cannot reach it at all", async () => {
    const deps = withTotp(0);
    const out = await dispatchCommand(deps, actor({ slackId: "U3", role: "pal" }), "C1", "2fa demo");
    expect(out).not.toContain("not wired up");
    expect(out.toLowerCase()).toContain("executer");
  });

  test("an empty store points at add rather than at nothing", async () => {
    const deps = withTotp(0);
    expect(await dispatchCommand(deps, actor(), "C1", "2fa")).toContain("2fa add");
  });

  test("only an admin may add a key", async () => {
    const deps = withTotp(0);
    const out = await dispatchCommand(deps, actor({ slackId: "U3", role: "executer" }), "C1", "2fa add demo");
    expect(out).toContain("Only admins");
    expect(deps.totp.list()).toHaveLength(0);
  });

  test("add never takes the key as command text - it offers the box", async () => {
    const deps = withTotp(0);
    const out = await dispatchCommand(deps, actor(), "C1", `2fa add demo ${SEED}`);
    expect(out).toContain("setup key");
    expect(out).not.toContain("GEZDGNBV");
    expect(deps.totp.list()).toHaveLength(0);
  });

  test("a code, with the account and the time left", async () => {
    const deps = withTotp(45_000);
    deps.totp.set("demo", SEED, OWNER, "demo@acme.io");
    const out = await dispatchCommand(deps, actor(), "C1", "2fa demo");
    const expected = totpCode(parseTotpInput(SEED)!, 45_000);
    expect(out).toContain(expected);
    expect(out).toContain("demo@acme.io");
    expect(out).toContain("15s");
  });

  test("hands over the next code when this one is about to expire", async () => {
    const deps = withTotp(58_000);
    deps.totp.set("demo", SEED, OWNER);
    const out = await dispatchCommand(deps, actor(), "C1", "2fa demo");
    expect(out).toContain(totpCode(parseTotpInput(SEED)!, 60_000));
    expect(out).toContain("next one");
  });

  test("the label is matched however it was typed", async () => {
    const deps = withTotp(45_000);
    deps.totp.set("shared-demo", SEED, OWNER);
    expect(await dispatchCommand(deps, actor(), "C1", "2fa  Shared Demo ")).toContain(
      totpCode(parseTotpInput(SEED)!, 45_000),
    );
  });

  test("an unknown label says what is actually held", async () => {
    const deps = withTotp(0);
    deps.totp.set("demo", SEED, OWNER);
    const out = await dispatchCommand(deps, actor(), "C1", "2fa nope");
    expect(out).toContain("No setup key");
    expect(out).toContain("demo");
  });

  test("list shows who added each one, and never the secret", async () => {
    const deps = withTotp(0);
    deps.totp.set("demo", SEED, OWNER, "demo@acme.io");
    const out = await dispatchCommand(deps, actor(), "C1", "2fa list");
    expect(out).toContain("demo");
    expect(out).toContain(OWNER);
    expect(out).not.toContain("GEZDGNBV");
  });

  test("remove is admin-only, and says when there was nothing to forget", async () => {
    const deps = withTotp(0);
    deps.totp.set("demo", SEED, OWNER);
    expect(await dispatchCommand(deps, actor({ slackId: "U3", role: "executer" }), "C1", "2fa remove demo")).toContain(
      "Only admins",
    );
    expect(deps.totp.has("demo")).toBe(true);
    expect(await dispatchCommand(deps, actor(), "C1", "2fa remove demo")).toContain("Forgotten");
    expect(await dispatchCommand(deps, actor(), "C1", "2fa remove demo")).toContain("had no setup key");
  });

  test("otp and totp reach the same command", async () => {
    const deps = withTotp(45_000);
    deps.totp.set("demo", SEED, OWNER);
    const expected = totpCode(parseTotpInput(SEED)!, 45_000);
    expect(await dispatchCommand(deps, actor(), "C1", "otp demo")).toContain(expected);
    expect(await dispatchCommand(deps, actor(), "C1", "totp demo")).toContain(expected);
  });
});

describe("follow", () => {
  test("a thread it did not start can be opted in, and out again", async () => {
    const deps = build();
    const follows = createFollowRepo(db);
    const d = { ...deps, follows };

    expect(follows.isFollowed("C7", "5.5")).toBe(false);
    const on = await dispatchCommand(d, actor(), "C7", "follow", { threadTs: "5.5" });
    expect(on).toContain("following that thread now");
    expect(on).toContain("staying quiet"); // it is judgement, not narration
    expect(follows.isFollowed("C7", "5.5")).toBe(true);

    const off = await dispatchCommand(d, actor(), "C7", "follow off", { threadTs: "5.5" });
    expect(off).toContain("stopped following");
    expect(follows.isFollowed("C7", "5.5")).toBe(false);
  });

  test("a link follows that thread rather than the one you typed in", async () => {
    const deps = build();
    const follows = createFollowRepo(db);
    await dispatchCommand(
      { ...deps, follows },
      actor(),
      "C1",
      "follow https://x.slack.com/archives/C9/p1793844324845749",
      { threadTs: "1.1" },
    );
    expect(follows.isFollowed("C9", "1793844324.845749")).toBe(true);
    expect(follows.isFollowed("C1", "1.1")).toBe(false);
  });

  test("it needs a thread, and says so rather than following nothing", async () => {
    const out = await dispatchCommand({ ...build(), follows: createFollowRepo(db) }, actor(), "C1", "follow");
    expect(out).toContain("Which thread?");
  });

  test("a bad link is refused, not treated as the current thread", async () => {
    const out = await dispatchCommand(
      { ...build(), follows: createFollowRepo(db) },
      actor(),
      "C1",
      "follow https://example.com/nope",
      { threadTs: "1.1" },
    );
    expect(out).toContain("not a Slack thread link");
  });

  test("turning it off when it was never on says so", async () => {
    const out = await dispatchCommand(
      { ...build(), follows: createFollowRepo(db) },
      actor(),
      "C1",
      "follow off",
      { threadTs: "1.1" },
    );
    expect(out).toContain("was not following");
  });

  test("it is admin and up - the bot speaks in a shared room unprompted", async () => {
    const out = await dispatchCommand(
      { ...build(), follows: createFollowRepo(db) },
      actor({ slackId: "U3", role: "pal" }),
      "C1",
      "follow",
      { threadTs: "1.1" },
    );
    expect(out).toContain("needs *admin*");
  });

  test("list names what it is keeping up with", async () => {
    const deps = build();
    const follows = createFollowRepo(db);
    const d = { ...deps, follows };
    expect(await dispatchCommand(d, actor(), "C1", "follow list")).toContain("not following any");
    await dispatchCommand(d, actor(), "C7", "follow", { threadTs: "5.5" });
    expect(await dispatchCommand(d, actor(), "C1", "follow list")).toContain("<#C7>");
  });
});

describe("snub", () => {
  const withSettings = () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    return deps;
  };

  test("adds, lists and removes, all in settings rather than source", async () => {
    const deps = withSettings();
    expect(await dispatchCommand(deps, actor(), "C1", "snub list")).toContain("Nobody is snubbed");

    const on = await dispatchCommand(deps, actor(), "C1", "snub <@U0NUISANCE>");
    expect(on).toContain("turned away");
    expect(deps.settings!.get("snubbed")).toBe("U0NUISANCE");

    expect(await dispatchCommand(deps, actor(), "C1", "snub list")).toContain("<@U0NUISANCE>");

    const off = await dispatchCommand(deps, actor(), "C1", "snub off <@U0NUISANCE>");
    expect(off).toContain("can ask again");
    expect(deps.settings!.get("snubbed")).toBe("");
  });

  test("the line they are told is configurable, and defaults to naming nobody", async () => {
    const deps = withSettings();
    await dispatchCommand(deps, actor(), "C1", "snub <@U0NUISANCE>");
    // with nothing configured they are turned away without anyone being named
    expect(await dispatchCommand(deps, actor(), "C1", "snub list")).toContain(DEFAULT_SNUB_REPLY);
    await dispatchCommand(deps, actor(), "C1", "snub reply ask me again next year 😏");
    expect(deps.settings!.get("snub_reply")).toBe("ask me again next year 😏");
  });

  test("snubbing somebody already on the allowlist is a contradiction", async () => {
    const deps = withSettings();
    deps.users.upsert(actor({ slackId: "U0FRIEND", role: "pal" }));
    expect(await dispatchCommand(deps, actor(), "C1", "snub <@U0FRIEND>")).toContain("already on the list");
  });

  test("it is admin and up", async () => {
    const out = await dispatchCommand(withSettings(), actor({ slackId: "U3", role: "pal" }), "C1", "snub list");
    expect(out).toContain("needs *admin*");
  });
});
