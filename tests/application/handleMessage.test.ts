import { describe, expect, test } from "bun:test";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { handleMessage, type HandleMessageDeps } from "../../src/application/handleMessage.ts";
import type { LlmPort } from "../../src/application/ports.ts";
import type { PromptMessage } from "../../src/domain/types.ts";

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
    expect(system).toContain("Reacting with emoji (optional, your call)");
    expect(system).toContain("channel=C1&timestamp=<ts>&name=<emoji>");
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
});
