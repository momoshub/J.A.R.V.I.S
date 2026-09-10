import { describe, expect, test } from "bun:test";
import {
  createHandler,
  shouldHandleDm,
  threadKeyOf,
  type Incoming,
  type SlackAppConfig,
  type SlackClient,
} from "../../src/infrastructure/slack/app.ts";
import type { Streamer } from "../../src/infrastructure/slack/stream.ts";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import type { LlmPort, LlmStreamEvent } from "../../src/application/ports.ts";
import type { RespondDeps } from "../../src/application/respond.ts";

const OWNER = "U0OWNER0001";

describe("threadKeyOf", () => {
  test("a top-level message is its own thread", () => {
    expect(threadKeyOf({ ts: "100.1" })).toBe("100.1");
  });
  test("a reply belongs to its parent thread, not to itself", () => {
    expect(threadKeyOf({ ts: "200.2", thread_ts: "100.1" })).toBe("100.1");
  });
});

describe("shouldHandleDm", () => {
  const base = { channel_type: "im", user: "U1", text: "hi" };
  test("accepts a plain human DM", () => {
    expect(shouldHandleDm(base)).toBe(true);
  });
  test("rejects bot echoes and subtypes (loop protection)", () => {
    expect(shouldHandleDm({ ...base, bot_id: "B1" })).toBe(false);
    expect(shouldHandleDm({ ...base, subtype: "message_changed" })).toBe(false);
  });
  test("rejects non-DM channels and empty messages", () => {
    expect(shouldHandleDm({ ...base, channel_type: "channel" })).toBe(false);
    expect(shouldHandleDm({ ...base, text: undefined })).toBe(false);
    expect(shouldHandleDm({ ...base, user: undefined })).toBe(false);
  });
});

type Recorded = { appends: unknown[]; stops: number; stopThrows: boolean; appendThrows: boolean };

const fakeStreamer = (rec: Recorded): Streamer => ({
  append: async (a) => {
    if (rec.appendThrows) throw new Error("append boom");
    rec.appends.push(a);
  },
  stop: async () => {
    if (rec.stopThrows) throw new Error("stop boom");
    rec.stops += 1;
  },
  ts: "222.2",
});

const build = (opts: {
  llm: LlmPort;
  streamUpdates: boolean;
  rec?: Recorded;
  thinkingAfterMs?: number;
}) => {
  const db = openDatabase(":memory:");
  const users = createUserRepo(db);
  const messages = createMessageRepo(db);
  users.upsert({ slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "system", createdAt: 1 });
  let t = 1;
  const deps: RespondDeps = {
    users,
    messages,
    llm: opts.llm,
    clock: () => t++,
    ownerSlackId: OWNER,
  };
  const config: SlackAppConfig = {
    botToken: "x",
    appToken: "x",
    streamUpdates: opts.streamUpdates,
    botName: "Evie",
    thinkingLabel: () => "thinking..",
    thinkingDoneLabel: () => "done",
    commandPrefix: "//bot",
    slashCommand: "/bot",
    thinkingAfterMs: opts.thinkingAfterMs ?? 5,
  };
  const said: { text: string; reply_broadcast?: boolean }[] = [];
  const updates: Record<string, unknown>[] = [];
  const rec = opts.rec ?? { appends: [], stops: 0, stopThrows: false, appendThrows: false };
  const client: SlackClient = {
    users: { info: async () => ({ user: { profile: { display_name: "Kai" } } }) },
    chatStream: () => fakeStreamer(rec),
    chat: {
      update: async (a) => {
        updates.push(a);
        return {};
      },
    },
  };
  const handle = createHandler(config, deps, () => {});
  const msg = (text: string, threadTs = "111.1"): Incoming => ({
    channelId: "C1",
    userId: OWNER,
    text,
    threadTs,
    messageTs: "111.1",
    client,
    say: async (m) => said.push({ text: m.text, ...(m.reply_broadcast ? { reply_broadcast: true } : {}) }),
  });
  return { handle, msg, said, updates, rec, messages };
};

const streamingLlm = (final: string, events: LlmStreamEvent[] = []): LlmPort => ({
  complete: async () => final,
  stream: async (_p, sink) => {
    for (const e of events) sink(e);
    return final;
  },
});

describe("createHandler streaming truth table", () => {
  test("successful stream shows content and does NOT double-post via say", async () => {
    const { handle, msg, said, rec } = build({
      llm: streamingLlm("hello there", [{ type: "text", delta: "hello there" }]),
      streamUpdates: true,
    });
    await handle(msg("hi"));
    expect(rec.stops).toBe(1);
    expect(said).toHaveLength(0);
    expect(rec.appends.some((a) => (a as { markdown_text?: string }).markdown_text === "hello there")).toBe(true);
  });

  test("falls back to say when the stream breaks", async () => {
    const rec: Recorded = { appends: [], stops: 0, stopThrows: false, appendThrows: true };
    const { handle, msg, said } = build({
      llm: streamingLlm("full reply", [{ type: "text", delta: "full reply" }]),
      streamUpdates: true,
      rec,
    });
    await handle(msg("hi"));
    expect(said).toEqual([{ text: "full reply", reply_broadcast: true }]);
  });

  test("posts once when streaming is disabled", async () => {
    const { handle, msg, said, rec } = build({
      llm: streamingLlm("plain post"),
      streamUpdates: false,
    });
    await handle(msg("hi"));
    expect(said).toEqual([{ text: "plain post", reply_broadcast: true }]);
    expect(rec.stops).toBe(0);
  });

  test("a thread the bot opened gets broadcast to the channel", async () => {
    const { handle, msg, updates } = build({
      llm: streamingLlm("hello there", [{ type: "text", delta: "hello there" }]),
      streamUpdates: true,
    });
    await handle(msg("hi"));
    expect(updates).toEqual([{ channel: "C1", ts: "222.2", reply_broadcast: true }]);
  });

  test("a reply inside an existing thread stays in the thread", async () => {
    const { handle, msg, updates, said } = build({
      llm: streamingLlm("hello there", [{ type: "text", delta: "hello there" }]),
      streamUpdates: true,
    });
    await handle(msg("hi", "000.9"));
    expect(updates).toHaveLength(0);
    expect(said).toHaveLength(0);
  });

  test("no broadcast when the reply is a plain post inside an existing thread", async () => {
    const { handle, msg, said } = build({ llm: streamingLlm("plain post"), streamUpdates: false });
    await handle(msg("hi", "000.9"));
    expect(said).toEqual([{ text: "plain post" }]);
  });

  const thinkingCard = (appends: unknown[]) =>
    appends.some(
      (a) => "chunks" in (a as object) && (a as { chunks: Array<{ id: string }> }).chunks[0]?.id === "__thinking__",
    );

  test("a quick answer never flashes a thinking step", async () => {
    const quick = build({
      llm: streamingLlm("ok", [{ type: "text", delta: "ok" }]),
      streamUpdates: true,
      thinkingAfterMs: 1_000, // far longer than this turn takes
    });
    await quick.handle(quick.msg("this is a fairly long message that exceeds forty chars"));
    expect(thinkingCard(quick.rec.appends)).toBe(false);
  });

  test("a slow turn shows one, however short the message was", async () => {
    const slow: LlmPort = {
      complete: async () => "ok",
      stream: async (_p, sink) => {
        await new Promise((r) => setTimeout(r, 25));
        sink({ type: "text", delta: "ok" });
        return "ok";
      },
    };
    const b = build({ llm: slow, streamUpdates: true, thinkingAfterMs: 1 });
    await b.handle(b.msg("hi"));
    expect(thinkingCard(b.rec.appends)).toBe(true);
  });

  test("posts an error message when respond throws", async () => {
    const boom: LlmPort = {
      complete: async () => "x",
      stream: async () => {
        throw new Error("llm down");
      },
    };
    const { handle, msg, said } = build({ llm: boom, streamUpdates: true });
    await handle(msg("hi"));
    expect(said).toHaveLength(1);
    expect(said[0]?.text).toContain("error");
  });
});
