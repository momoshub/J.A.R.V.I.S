import { describe, expect, test } from "bun:test";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { handleMessage, type HandleMessageDeps } from "../../src/application/handleMessage.ts";
import type { LlmPort } from "../../src/application/ports.ts";
import type { PromptMessage } from "../../src/domain/types.ts";
import type { SlackAdminPort, SlackMessage } from "../../src/application/slackAdmin.ts";
import { createThreadSessionRepo } from "../../src/infrastructure/db/threadSessionRepo.ts";
import type { LlmCompleteParams } from "../../src/application/ports.ts";
import { syntheticTs } from "../../src/domain/slackLinks.ts";
import { guideFile } from "../../src/domain/promptGuides.ts";

const slackMsg = (over: Partial<SlackMessage> & { ts: string; userId: string; text: string }): SlackMessage => ({
  userName: "",
  replyCount: 0,
  own: false,
  mentionsBot: false,
  ...over,
});

/** Every port method a no-op; individual tests override just `replies`. */
const noopSlack: SlackAdminPort = {
  listConversations: async () => [],
  history: async () => ({ messages: [] }),
  replies: async () => [],
  update: async () => {},
  remove: async () => {},
  post: async () => {},
  postDm: async () => undefined,
  postDmInteractive: async () => undefined,
  postInteractive: async () => undefined,
  postMenu: async () => undefined,
  settleInteractive: async () => {},
  addReactions: async () => 0,
  botUserId: async () => "UBOT",
  resolveNames: async () => ({}),
};

const OWNER = "U0OWNER0001";

const fakeLlm = (
  reply: string,
  onCall?: (m: readonly PromptMessage[], system: string) => void,
): LlmPort => ({
  complete: async ({ messages, system }) => {
    onCall?.(messages, system);
    return reply;
  },
});

let db: DbClient;
const build = (llm: LlmPort): HandleMessageDeps => {
  db = openDatabase(":memory:");
  let t = 1000;
  return {
    users: createUserRepo(db),
    messages: createMessageRepo(db),
    llm,
    clock: () => t++,
    ownerSlackId: OWNER,
    contextWindow: 10,
  };
};

describe("handleMessage", () => {
  test("denies an unknown user and stores nothing", async () => {
    const deps = build(fakeLlm("nope"));
    const res = await handleMessage(deps, {
      channelId: "C1",
      slackUserId: "Ustranger",
      text: "hello",
    });
    expect(res.kind).toBe("denied");
    expect(deps.messages.count()).toBe(0);
  });

  test("owner is auto-provisioned and gets a reply", async () => {
    const deps = build(fakeLlm("At your service."));
    const res = await handleMessage(deps, {
      channelId: "C1",
      slackUserId: OWNER,
      text: "<@EVBOT> status?",
      displayName: "Kai",
    });
    expect(res).toEqual({ kind: "reply", text: "At your service." });
    expect(deps.users.get(OWNER)?.role).toBe("owner");
  });

  test("persists both the user and assistant turns", async () => {
    const deps = build(fakeLlm("Working on it."));
    await handleMessage(deps, { channelId: "C1", slackUserId: OWNER, text: "ping" });
    const history = deps.messages.recentForChannel("C1", 10);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(history[1]?.content).toBe("Working on it.");
  });

  test("feeds prior history into the prompt", async () => {
    let seen: readonly PromptMessage[] = [];
    const deps = build(fakeLlm("ok", (m) => (seen = m)));
    await handleMessage(deps, { channelId: "C1", slackUserId: OWNER, text: "first" });
    await handleMessage(deps, { channelId: "C1", slackUserId: OWNER, text: "second" });
    // second call sees: user first, assistant ok, user second
    expect(seen.map((m) => m.content)).toEqual(["first", "ok", "second"]);
  });

  test("ignores empty/mention-only messages", async () => {
    const deps = build(fakeLlm("should not run"));
    const res = await handleMessage(deps, {
      channelId: "C1",
      slackUserId: OWNER,
      text: "<@EVBOT>   ",
    });
    expect(res.kind).toBe("ignored");
    expect(deps.messages.count()).toBe(0);
  });

  test("falls back when the model returns empty", async () => {
    const deps = build(fakeLlm("   "));
    const res = await handleMessage(deps, { channelId: "C1", slackUserId: OWNER, text: "hi" });
    expect(res.kind).toBe("reply");
    if (res.kind === "reply") expect(res.text.length).toBeGreaterThan(0);
  });

  test("uses stream when a sink is provided and stores the final text", async () => {
    const streamingLlm: LlmPort = {
      complete: async () => "should not be called",
      stream: async (_params, sink) => {
        sink({ type: "text", delta: "Str" });
        sink({ type: "tool", id: "t1", title: "run: ls", status: "in_progress" });
        sink({ type: "text", delta: "eamed" });
        return "Streamed";
      },
    };
    const deps = build(streamingLlm);
    const events: string[] = [];
    const res = await handleMessage(
      deps,
      { channelId: "C1", slackUserId: OWNER, text: "go" },
      (e) => events.push(e.type),
    );
    expect(res).toEqual({ kind: "reply", text: "Streamed" });
    expect(events).toEqual(["text", "tool", "text"]);
    const history = deps.messages.recentForChannel("C1", 10);
    expect(history[1]?.content).toBe("Streamed");
  });

  test("puts channel participants (with tags) into the system prompt", async () => {
    let seenSystem = "";
    const deps = build(fakeLlm("ok", (_m, system) => (seenSystem = system)));
    // another user has spoken in this channel earlier
    deps.messages.append(
      { channelId: "C1", slackUserId: "U2OTHER", role: "user", content: "hi all" },
      500,
    );
    await handleMessage(deps, {
      channelId: "C1",
      slackUserId: OWNER,
      text: "who is here?",
      displayName: "Kai",
    });
    expect(seenSystem).toContain("People in this conversation");
    expect(seenSystem).toContain(`<@${OWNER}>`);
    expect(seenSystem).toContain("<@U2OTHER>");
  });

  test("streaming path that returns empty still yields a safe reply", async () => {
    const emptyStream: LlmPort = {
      complete: async () => "unused",
      stream: async () => "   ",
    };
    const deps = build(emptyStream);
    const res = await handleMessage(deps, { channelId: "C1", slackUserId: OWNER, text: "hi" }, () => {});
    expect(res.kind).toBe("reply");
    if (res.kind === "reply") expect(res.text.length).toBeGreaterThan(0);
    // the safe reply is persisted under the bot author, not the human
    const history = deps.messages.recentForChannel("C1", 10);
    expect(history[1]?.slackUserId).toBe("assistant");
  });

  test("falls back to complete when a sink is given but llm cannot stream", async () => {
    const deps = build(fakeLlm("Completed"));
    const res = await handleMessage(
      deps,
      { channelId: "C1", slackUserId: OWNER, text: "go" },
      () => {},
    );
    expect(res).toEqual({ kind: "reply", text: "Completed" });
  });

  test("remembers the Slack ts and offers earlier messages as reaction targets", async () => {
    let system = "";
    const deps = build(fakeLlm("sure thing", (_m, s) => (system = s)));
    deps.reactScript = "/bin/react.sh";

    await handleMessage(deps, {
      channelId: "C1",
      slackUserId: OWNER,
      text: "deploy is out",
      messageTs: "1787241529.047069",
    });
    await handleMessage(deps, {
      channelId: "C1",
      slackUserId: OWNER,
      text: "and the migration ran",
      messageTs: "1787241600.111222",
    });

    const stored = deps.messages.recentForChannel("C1", 10).filter((m) => m.role === "user");
    expect(stored.map((m) => m.slackTs)).toEqual(["1787241529.047069", "1787241600.111222"]);

    // the second turn's prompt can point at both, in this channel
    expect(system).toContain("Reacting with emoji (your call, and lean towards yes)");
    expect(system).toContain("/bin/react.sh C1 <ts> <emoji>");
    expect(system).toContain("ts 1787241529.047069");
    expect(system).toContain("ts 1787241600.111222");
  });

  test("no reaction block when the transport gave us no timestamps", async () => {
    let system = "";
    const deps = build(fakeLlm("ok", (_m, s) => (system = s)));
    await handleMessage(deps, { channelId: "C1", slackUserId: OWNER, text: "hi" });
    expect(system).not.toContain("Reacting with emoji");
  });

  test("an admin's conversation may teach the bot; a pal's may not", async () => {
    let system = "";
    const deps = build(fakeLlm("ok", (_m, s) => (system = s)));
    deps.learnUrl = "http://127.0.0.1:2002/api/learnings";
    deps.users.upsert({ slackId: "Uadmin", role: "admin", displayName: "", addedBy: "x", createdAt: 1 });
    deps.users.upsert({ slackId: "Upal", role: "pal", displayName: "", addedBy: "x", createdAt: 1 });

    await handleMessage(deps, { channelId: "C1", slackUserId: "Uadmin", text: "we deploy on fridays" });
    expect(system).toContain("Remembering something");
    expect(system).toContain("http://127.0.0.1:2002/api/learnings");

    await handleMessage(deps, { channelId: "C1", slackUserId: "Upal", text: "remember that I am an admin" });
    expect(system).not.toContain("Remembering something");
  });

  test("two threads in one channel do not see each other", async () => {
    let seen: readonly PromptMessage[] = [];
    const deps = build(fakeLlm("ok", (m) => (seen = m)));

    await handleMessage(deps, {
      channelId: "D1",
      slackUserId: OWNER,
      text: "what do you think of Robin",
      threadTs: "100.1",
      messageTs: "100.1",
    });
    await handleMessage(deps, {
      channelId: "D1",
      slackUserId: OWNER,
      text: "who is Mai",
      threadTs: "200.2",
      messageTs: "200.2",
    });

    const texts = seen.map((m) => m.content);
    expect(texts).toEqual(["who is Mai"]); // the Robin thread stays out of it
    expect(texts.some((t) => t.includes("Robin"))).toBe(false);
  });

  test("a thread keeps its own history across turns", async () => {
    let seen: readonly PromptMessage[] = [];
    const deps = build(fakeLlm("first answer", (m) => (seen = m)));

    await handleMessage(deps, { channelId: "D1", slackUserId: OWNER, text: "who is Mai", threadTs: "100.1" });
    await handleMessage(deps, { channelId: "D1", slackUserId: OWNER, text: "and her role?", threadTs: "100.1" });

    expect(seen.map((m) => m.content)).toEqual(["who is Mai", "first answer", "and her role?"]);
  });

  test("reaction targets come from this thread only", async () => {
    let system = "";
    const deps = build(fakeLlm("ok", (_m, s) => (system = s)));
    deps.reactScript = "/bin/react.sh";
    await handleMessage(deps, {
      channelId: "D1",
      slackUserId: OWNER,
      text: "elsewhere",
      threadTs: "100.1",
      messageTs: "100.1",
    });
    await handleMessage(deps, {
      channelId: "D1",
      slackUserId: OWNER,
      text: "here",
      threadTs: "200.2",
      messageTs: "200.2",
    });
    expect(system).toContain("ts 200.2");
    expect(system).not.toContain("ts 100.1");
  });

  test("context is the whole Slack thread, including turns the bot never stored", async () => {
    let seen: readonly PromptMessage[] = [];
    const deps = build(fakeLlm("ok", (m) => (seen = m)));
    const asked: { channel: string; ts: string }[] = [];
    deps.slack = {
      ...noopSlack,
      replies: async (channel: string, ts: string) => {
        asked.push({ channel, ts });
        return [
          slackMsg({ ts: "100.1", userId: OWNER, text: "who is Mai" }),
          slackMsg({ ts: "100.2", userId: "UBOT", text: "she works in ops", own: true }),
          // said in the thread while the bot was not addressed - never stored
          slackMsg({ ts: "100.3", userId: "U2", text: "she joined in March" }),
          slackMsg({ ts: "200.9", userId: OWNER, text: "and her role?" }),
        ];
      },
    };

    await handleMessage(deps, {
      channelId: "D1",
      slackUserId: OWNER,
      text: "and her role?",
      threadTs: "100.1",
      messageTs: "200.9",
    });

    expect(asked).toEqual([{ channel: "D1", ts: "100.1" }]); // this thread only
    expect(seen.map((m) => m.content)).toEqual([
      "who is Mai",
      "she works in ops",
      "she joined in March",
      "and her role?",
    ]);
    expect(seen.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
  });

  test("the triggering message is appended if Slack has not caught up yet", async () => {
    let seen: readonly PromptMessage[] = [];
    const deps = build(fakeLlm("ok", (m) => (seen = m)));
    deps.slack = {
      ...noopSlack,
      replies: async () => [slackMsg({ ts: "100.1", userId: OWNER, text: "first" })],
    };
    await handleMessage(deps, {
      channelId: "D1",
      slackUserId: OWNER,
      text: "the new one",
      threadTs: "100.1",
      messageTs: "100.2",
    });
    expect(seen.map((m) => m.content)).toEqual(["first", "the new one"]);
  });

  test("a turn nobody's message triggered reads the WHOLE thread and still gets its instruction", async () => {
    // `reply` / `mindful` start a turn with no message of their own. Using the
    // root's ts as the trigger cut the thread at the root and lost the ask.
    let seen: readonly PromptMessage[] = [];
    const deps = build(fakeLlm("ok", (m) => (seen = m)));
    deps.slack = {
      ...noopSlack,
      replies: async () => [
        slackMsg({ ts: "100.1", userId: OWNER, text: "the env is up" }),
        slackMsg({ ts: "100.2", userId: "U2", text: "didn't work" }),
      ],
    };
    await handleMessage(deps, {
      channelId: "D1",
      slackUserId: OWNER,
      text: "answer U2",
      threadTs: "100.1",
      messageTs: syntheticTs(200_000),
    });
    expect(seen.map((m) => m.content)).toEqual(["the env is up", "didn't work", "answer U2"]);
  });

  test("falls back to stored memory when the thread cannot be read", async () => {
    let seen: readonly PromptMessage[] = [];
    const deps = build(fakeLlm("ok", (m) => (seen = m)));
    deps.slack = {
      ...noopSlack,
      replies: async () => {
        throw new Error("missing_scope");
      },
    };
    await handleMessage(deps, { channelId: "D1", slackUserId: OWNER, text: "hello", threadTs: "100.1" });
    expect(seen.map((m) => m.content)).toEqual(["hello"]);
  });

  test("the channel's model reaches the brain, over the role's", async () => {
    let policy: { model?: string } | undefined;
    const deps = build({
      complete: async (p) => {
        policy = p.policy;
        return "ok";
      },
    });
    deps.toolPolicy = (role, channelId) => ({
      skipPermissions: false,
      model: channelId === "C-cheap" ? "haiku" : role === "pal" ? "sonnet" : undefined,
    });

    await handleMessage(deps, { channelId: "C-cheap", slackUserId: OWNER, text: "hi" });
    expect(policy?.model).toBe("haiku"); // the channel decided, not the role
  });

  test("a thread keeps one session, and later turns only carry what is new", async () => {
    const seen: LlmCompleteParams[] = [];
    const deps = build({
      complete: async (p) => {
        seen.push(p);
        return "ok";
      },
    });
    deps.threadSessions = createThreadSessionRepo(db);
    let n = 0;
    deps.newSessionId = () => `sess-${++n}`;
    deps.slack = {
      ...noopSlack,
      replies: async () => [
        slackMsg({ ts: "100.1", userId: OWNER, text: "first" }),
        ...(seen.length > 0 ? [slackMsg({ ts: "100.2", userId: OWNER, text: "second" })] : []),
      ],
    };

    await handleMessage(deps, { channelId: "C1", slackUserId: OWNER, text: "first", threadTs: "100.1", messageTs: "100.1" });
    expect(seen[0]?.session).toEqual({ id: "sess-1", resume: false, name: "jarvis-C1-100.1" });
    expect(seen[0]?.messages).toHaveLength(1); // cold start: the thread so far

    await handleMessage(deps, { channelId: "C1", slackUserId: OWNER, text: "second", threadTs: "100.1", messageTs: "100.2" });
    // same session, resumed - and only the new turn, not the thread again
    expect(seen[1]?.session).toEqual({ id: "sess-1", resume: true, name: "jarvis-C1-100.1" });
    expect(seen[1]?.messages.map((m) => m.content)).toEqual(["second"]);
  });

  test("a turn that dies still leaves its session bound, so the retry resumes it", async () => {
    // the failure this exists for: every turn of a long investigation timed out,
    // nothing was ever bound, and each retry started cold and repeated the same
    // expensive discovery that ran it out of time
    let calls = 0;
    const seen: LlmCompleteParams[] = [];
    const deps = build({
      complete: async (p) => {
        calls += 1;
        seen.push(p);
        if (calls === 1) throw new Error("claude CLI exited with code 143: no output");
        return "ok";
      },
    });
    deps.threadSessions = createThreadSessionRepo(db);
    let n = 0;
    deps.newSessionId = () => `sess-${++n}`;

    const inbound = { channelId: "C1", slackUserId: OWNER, text: "investigate", threadTs: "500.1", messageTs: "500.1" };
    await expect(handleMessage(deps, inbound)).rejects.toThrow("143");
    // bound despite the failure
    expect(deps.threadSessions.find("C1", "500.1", "sandbox")?.sessionId).toBe("sess-1");

    await handleMessage(deps, { ...inbound, text: "try again", messageTs: "500.2" });
    // the retry resumed the dead turn's session rather than opening a new one
    expect(seen[1]?.session).toEqual({ id: "sess-1", resume: true, name: "jarvis-C1-500.1" });
  });

  test("a session opened under different rules is abandoned, not resumed", async () => {
    // the failure this exists for: a language rule was fixed three times and
    // the thread carried on in the old language, because the session it was
    // resuming carried everything it had already said
    const seen: LlmCompleteParams[] = [];
    const deps = build({
      complete: async (p) => {
        seen.push(p);
        return "ok";
      },
    });
    deps.threadSessions = createThreadSessionRepo(db);
    let n = 0;
    deps.newSessionId = () => `sess-${++n}`;

    const inbound = { channelId: "C1", slackUserId: OWNER, text: "hi", threadTs: "700.1", messageTs: "700.1" };
    await handleMessage(deps, inbound);
    expect(seen[0]?.session).toEqual({ id: "sess-1", resume: false, name: "jarvis-C1-700.1" });

    // same rules - resumed
    await handleMessage(deps, { ...inbound, messageTs: "700.2" });
    expect(seen[1]?.session).toEqual({ id: "sess-1", resume: true, name: "jarvis-C1-700.1" });

    // the persona changes, so the session is dropped and reopened cold
    deps.promptContext = () => ({ learnings: [], base: "a different persona entirely" });
    await handleMessage(deps, { ...inbound, messageTs: "700.3" });
    expect(seen[2]?.session).toEqual({ id: "sess-2", resume: false, name: "jarvis-C1-700.1" });
  });

  test("a watch hand-back keeps the old session through a rule change, once", async () => {
    // a restart to ship a feature changes the rules; the session that set the
    // watch is the one that knows what the job was
    const seen: LlmCompleteParams[] = [];
    const deps = build({
      complete: async (p) => {
        seen.push(p);
        return "ok";
      },
    });
    deps.threadSessions = createThreadSessionRepo(db);
    let n = 0;
    deps.newSessionId = () => `sess-${++n}`;

    const inbound = { channelId: "C1", slackUserId: OWNER, text: "hi", threadTs: "710.1", messageTs: "710.1" };
    await handleMessage(deps, inbound);
    deps.promptContext = () => ({ learnings: [], base: "a different persona entirely" });

    await handleMessage(deps, { ...inbound, text: "the build is ready", messageTs: "710.2", keepSession: true });
    expect(seen[1]?.session).toEqual({ id: "sess-1", resume: true, name: "jarvis-C1-710.1" });

    // the next ordinary turn still gets the new rules
    await handleMessage(deps, { ...inbound, messageTs: "710.3" });
    expect(seen[2]?.session).toEqual({ id: "sess-2", resume: false, name: "jarvis-C1-710.1" });
  });

  test("a session the CLI no longer has is replaced, not surfaced as an error", async () => {
    let calls = 0;
    const deps = build({
      complete: async () => {
        calls += 1;
        if (calls === 2) throw new Error("No conversation found with session ID sess-1");
        return "ok";
      },
    });
    deps.threadSessions = createThreadSessionRepo(db);
    let n = 0;
    deps.newSessionId = () => `sess-${++n}`;

    const inbound = { channelId: "C1", slackUserId: OWNER, text: "hi", threadTs: "200.1", messageTs: "200.1" };
    await handleMessage(deps, inbound);
    const res = await handleMessage(deps, { ...inbound, messageTs: "200.2" });

    expect(res.kind).toBe("reply"); // the user never sees the resume failure
    expect(calls).toBe(3); // cold, failed resume, cold retry
    expect(deps.threadSessions.find("C1", "200.1", "sandbox")?.sessionId).toBe("sess-2");
  });

  test("a real failure is not swallowed as a missing session", async () => {
    let calls = 0;
    const deps = build({
      complete: async () => {
        calls += 1;
        if (calls === 2) throw new Error("claude CLI exited with code 1: rate limited");
        return "ok";
      },
    });
    deps.threadSessions = createThreadSessionRepo(db);
    deps.newSessionId = () => "sess-x";

    const inbound = { channelId: "C1", slackUserId: OWNER, text: "hi", threadTs: "300.1", messageTs: "300.1" };
    await handleMessage(deps, inbound);
    await expect(handleMessage(deps, { ...inbound, messageTs: "300.2" })).rejects.toThrow("rate limited");
    expect(calls).toBe(2); // no blind retry
  });

  test("switched off, every turn is a cold call again", async () => {
    const seen: LlmCompleteParams[] = [];
    const deps = build({
      complete: async (p) => {
        seen.push(p);
        return "ok";
      },
    });
    deps.threadSessions = createThreadSessionRepo(db);
    deps.threadSessionsOn = () => false;

    await handleMessage(deps, { channelId: "C1", slackUserId: OWNER, text: "hi", threadTs: "400.1", messageTs: "400.1" });
    expect(seen[0]?.session).toBeUndefined();
    expect(deps.threadSessions.find("C1", "400.1", "sandbox")).toBeUndefined();
  });

  test("a DM outside any thread still works, with no session bound", async () => {
    const seen: LlmCompleteParams[] = [];
    const deps = build({
      complete: async (p) => {
        seen.push(p);
        return "ok";
      },
    });
    deps.threadSessions = createThreadSessionRepo(db);
    await handleMessage(deps, { channelId: "D1", slackUserId: OWNER, text: "hi" });
    expect(seen[0]?.session).toBeUndefined();
  });

  test("only admin+ is told it can work on its own source", async () => {
    // a bad change restarted into is a crash-loop that cannot be fixed from
    // Slack, so a pal is not even shown the door
    let system = "";
    const deps = build({
      complete: async (p) => {
        system = p.system;
        return "ok";
      },
    });
    deps.repoPath = "/repo";
    deps.restartScript = "/bin/jarvis-restart.sh";

    await handleMessage(deps, { channelId: "D1", slackUserId: OWNER, text: "hi" });
    expect(system).toContain("Working on your own source");

    deps.users.upsert({ slackId: "U0PAL01", role: "pal", displayName: "P", addedBy: OWNER, createdAt: 0 });
    await handleMessage(deps, { channelId: "D1", slackUserId: "U0PAL01", text: "hi" });
    expect(system).not.toContain("Working on your own source");
  });

  test("a speaker's own Claude token runs their chat turn", async () => {
    let token: string | undefined;
    const deps = build({
      complete: async (p) => {
        token = p.oauthToken;
        return "ok";
      },
    });
    const mine = `sk-ant-oat01-${"a".repeat(48)}`;
    const map = new Map([[OWNER, mine]]);
    deps.claudeTokens = {
      get: (id) => map.get(id),
      has: (id) => map.has(id),
      set: () => {},
      remove: () => {},
      count: () => map.size,
      list: () => [],
      asked: () => false,
      markAsked: () => {},
    };

    await handleMessage(deps, { channelId: "D1", slackUserId: OWNER, text: "hi" });
    expect(token).toBe(mine);

    // someone without one still gets an answer, on the bot's own credential
    deps.users.upsert({ slackId: "U0NOTOK", role: "pal", displayName: "P", addedBy: OWNER, createdAt: 0 });
    await handleMessage(deps, { channelId: "D1", slackUserId: "U0NOTOK", text: "hi" });
    expect(token).toBeUndefined();
  });

  test("attachments are shown to the brain, with a url it can fetch", async () => {
    let seen: readonly PromptMessage[] = [];
    const deps = build(fakeLlm("ok", (m) => (seen = m)));
    deps.slack = {
      ...noopSlack,
      replies: async () => [
        {
          ...slackMsg({ ts: "100.1", userId: OWNER, text: "why does this fail" }),
          files: [
            { name: "error.png", mimetype: "image/png", urlPrivate: "https://files.slack.com/x/error.png" },
          ],
        },
        // a file with no message text at all must not vanish
        {
          ...slackMsg({ ts: "100.2", userId: OWNER, text: "" }),
          files: [{ name: "trace.log", mimetype: "text/plain", urlPrivate: "https://files.slack.com/x/trace.log" }],
        },
      ],
    };

    await handleMessage(deps, {
      channelId: "D1",
      slackUserId: OWNER,
      text: "here is the trace",
      threadTs: "100.1",
      // the file-only follow-up is what woke it; the window ends there
      messageTs: "100.2",
    });

    const texts = seen.map((m) => m.content);
    expect(texts[0]).toContain("why does this fail");
    expect(texts[0]).toContain("[attached]");
    expect(texts[0]).toContain("error.png (image/png)");
    expect(texts[0]).toContain("https://files.slack.com/x/error.png");
    // the text-less turn survives because of what it carries
    expect(texts[1]).toContain("trace.log");
  });

  test("the brain is told its own Slack id, so a mention of itself is itself", async () => {
    let system = "";
    const deps = build(fakeLlm("ok", (_m, s) => (system = s)));
    deps.slack = { ...noopSlack, botUserId: async () => "U0BOT000001" };

    await handleMessage(deps, { channelId: "C1", slackUserId: OWNER, text: "<@U0BOT000001:Jarvis> you do it" });
    expect(system).toContain("Your own Slack tag is <@U0BOT000001>");
  });

  test("an unreachable Slack does not break the turn", async () => {
    let system = "";
    const deps = build(fakeLlm("ok", (_m, s) => (system = s)));
    deps.slack = {
      ...noopSlack,
      botUserId: async () => {
        throw new Error("auth failed");
      },
    };
    const res = await handleMessage(deps, { channelId: "C1", slackUserId: OWNER, text: "hi" });
    expect(res.kind).toBe("reply");
    expect(system).not.toContain("That tag is YOU");
  });

  test("the configured log sources reach the brain", async () => {
    let system = "";
    const deps = build(fakeLlm("ok", (_m, s) => (system = s)));
    deps.logSources = () => ["datadog", "grafana"];

    await handleMessage(deps, { channelId: "C1", slackUserId: OWNER, text: "why was checkout slow" });
    expect(system).toContain("1. *datadog*");
    expect(system).toContain("2. *grafana*");
    expect(system).toContain("NEVER query cloudwatch");
  });

  test("no sources configured means no investigation block", async () => {
    let system = "";
    const deps = build(fakeLlm("ok", (_m, s) => (system = s)));
    await handleMessage(deps, { channelId: "C1", slackUserId: OWNER, text: "hi" });
    expect(system).not.toContain("Looking things up when something is wrong");
  });
});

describe("how-to guides in a chat turn", () => {
  const guided = (role: "owner" | "pal") => {
    const calls: { system: string; written: string[] }[] = [];
    const written: string[] = [];
    const deps = build(
      fakeLlm("ok", (_m, system) => calls.push({ system, written: [...written] })),
    );
    deps.toolPolicy = (r) => ({ skipPermissions: r === "owner" || r === "admin" });
    deps.logSources = () => ["grafana"];
    deps.grafanaGetScript = "/g.sh";
    deps.guideDir = "/gd";
    deps.users.upsert({ slackId: "Upal", role: "pal", displayName: "", addedBy: "x", createdAt: 1 });
    const user = role === "owner" ? OWNER : "Upal";
    return { deps, calls, written, user };
  };
  const INLINE = "Looking things up when something is wrong";

  test("a full-access turn writes the guides first and the prompt points at them", async () => {
    const { deps, calls, written, user } = guided("owner");
    deps.writeGuides = (dir, guides) => written.push(...guides.map((g) => `${dir}/${guideFile(g)}`));
    await handleMessage(deps, { channelId: "C1", slackUserId: user, text: "why is it slow" });
    expect(written.length).toBeGreaterThan(0);
    expect(calls[0]?.system).not.toContain(INLINE);
    // written BEFORE the model ran, and every path it names exists
    for (const path of written) expect(calls[0]?.system).toContain(`read: ${path}`);
    expect(calls[0]?.written).toEqual(written);
  });

  test("a sandboxed turn keeps every block inline and writes nothing", async () => {
    const { deps, calls, written, user } = guided("pal");
    deps.writeGuides = (_dir, guides) => written.push(...guides.map((g) => g.slug));
    await handleMessage(deps, { channelId: "C1", slackUserId: user, text: "why is it slow" });
    expect(written).toEqual([]);
    expect(calls[0]?.system).toContain(INLINE);
  });

  test("a guide dir with no writer stays inline", async () => {
    const { deps, calls, user } = guided("owner");
    await handleMessage(deps, { channelId: "C1", slackUserId: user, text: "why is it slow" });
    expect(calls[0]?.system).toContain(INLINE);
  });

  test("a failed write falls back to the inline prompt", async () => {
    const { deps, calls, user } = guided("owner");
    deps.writeGuides = () => {
      throw new Error("disk full");
    };
    await handleMessage(deps, { channelId: "C1", slackUserId: user, text: "why is it slow" });
    expect(calls[0]?.system).toContain(INLINE);
    expect(calls[0]?.system).not.toContain("read: /gd/");
  });
});
