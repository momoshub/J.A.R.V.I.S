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
});
