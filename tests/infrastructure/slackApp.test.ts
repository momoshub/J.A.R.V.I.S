import { describe, expect, test } from "bun:test";
import {
  createHandler,
  shouldHandleDm,
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
});

const build = (opts: {
  llm: LlmPort;
  streamUpdates: boolean;
  rec?: Recorded;
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
  };
  const said: { text: string }[] = [];
  const rec = opts.rec ?? { appends: [], stops: 0, stopThrows: false, appendThrows: false };
  const client: SlackClient = {
    users: { info: async () => ({ user: { profile: { display_name: "Kai" } } }) },
    chatStream: () => fakeStreamer(rec),
  };
  const handle = createHandler(config, deps, () => {});
  const msg = (text: string): Incoming => ({
    channelId: "C1",
    userId: OWNER,
    text,
    threadTs: "111.1",
    client,
    say: async (m) => said.push({ text: m.text }),
  });
  return { handle, msg, said, rec, messages };
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
    expect(said).toEqual([{ text: "full reply" }]);
  });

  test("posts once when streaming is disabled", async () => {
    const { handle, msg, said, rec } = build({
      llm: streamingLlm("plain post"),
      streamUpdates: false,
    });
    await handle(msg("hi"));
    expect(said).toEqual([{ text: "plain post" }]);
    expect(rec.stops).toBe(0);
  });

  test("shows a thinking step for long messages, not short ones", async () => {
    const long = build({ llm: streamingLlm("ok", [{ type: "text", delta: "ok" }]), streamUpdates: true });
    await long.handle(long.msg("this is a fairly long message that exceeds forty chars"));
    const firstTask = long.rec.appends.find((a) => "chunks" in (a as object)) as
      | { chunks: Array<{ id: string; status: string }> }
      | undefined;
    expect(firstTask?.chunks[0]?.id).toBe("__thinking__");

    const short = build({ llm: streamingLlm("ok", [{ type: "text", delta: "ok" }]), streamUpdates: true });
    await short.handle(short.msg("hi"));
    const anyThinking = short.rec.appends.some(
      (a) => "chunks" in (a as object) && (a as { chunks: Array<{ id: string }> }).chunks[0]?.id === "__thinking__",
    );
    expect(anyThinking).toBe(false);
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
