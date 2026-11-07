import { describe, expect, test } from "bun:test";
import {
  createHandler,
  createKitListeners,
  retireOpenKit,
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
  test("handles a DM that carries files (file_share is still a message)", () => {
    expect(shouldHandleDm({ ...base, subtype: "file_share" })).toBe(true);
  });
  test("rejects non-DM channels and empty messages", () => {
    expect(shouldHandleDm({ ...base, channel_type: "channel" })).toBe(false);
    expect(shouldHandleDm({ ...base, text: undefined })).toBe(false);
    expect(shouldHandleDm({ ...base, user: undefined })).toBe(false);
  });
});

type Recorded = { appends: unknown[]; stops: number; stopThrows: boolean; appendThrows: boolean };

const fakeStreamer = (rec: Recorded, ts = "222.2"): Streamer => ({
  append: async (a) => {
    if (rec.appendThrows) throw new Error("append boom");
    rec.appends.push(a);
  },
  stop: async () => {
    if (rec.stopThrows) throw new Error("stop boom");
    rec.stops += 1;
  },
  ts,
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
  const deletes: string[] = [];
  const rec = opts.rec ?? { appends: [], stops: 0, stopThrows: false, appendThrows: false };
  // The first message keeps the old fixed ts; a rollover gets its own.
  let streams = 0;
  const client: SlackClient = {
    users: { info: async () => ({ user: { profile: { display_name: "Kai" } } }) },
    chatStream: () => fakeStreamer(rec, streams++ === 0 ? "222.2" : `222.${streams + 1}`),
    chat: {
      update: async (a) => {
        updates.push(a);
        return {};
      },
      delete: async (a) => {
        deletes.push(String(a.ts));
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
  return { handle, msg, said, updates, deletes, rec, messages };
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

  test("a stream Slack already closed is rewritten into the answer, not posted again", async () => {
    // a long turn: Slack closed the stream before the end, so the stop fails
    const rec: Recorded = { appends: [], stops: 0, stopThrows: true, appendThrows: false };
    const { handle, msg, said, updates } = build({
      llm: streamingLlm("the full answer", [{ type: "text", delta: "half of it" }]),
      streamUpdates: true,
      rec,
    });
    await handle(msg("hi", "000.9"));
    expect(said).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ ts: "222.2", text: "the full answer" });
  });

  test("a closed stream that rolled over keeps the answer on its first message only", async () => {
    const rec: Recorded = { appends: [], stops: 0, stopThrows: true, appendThrows: false };
    const head = "a".repeat(10_000);
    const tail = "b".repeat(3_000);
    const r = build({
      llm: streamingLlm("the full answer", [{ type: "text", delta: head }, { type: "text", delta: tail }]),
      streamUpdates: true,
      rec,
    });
    await r.handle(r.msg("hi", "000.9"));
    expect(r.said).toHaveLength(0);
    expect(r.updates.map((u) => u.ts)).toEqual(["222.2"]);
    expect(r.deletes).toHaveLength(1);
    expect(r.deletes).not.toContain("222.2");
  });

  test("a reply that rolled over is tidied message by message, footer on the last", async () => {
    const steps: LlmStreamEvent[] = [
      { type: "tool", id: "t1", title: "run: one", status: "complete" },
      { type: "tool", id: "t2", title: "run: two", status: "complete" },
    ];
    const head = "a".repeat(10_000);
    const tail = "b".repeat(3_000);
    const two = build({
      llm: streamingLlm(head + tail, [...steps, { type: "text", delta: head }, { type: "text", delta: tail }]),
      streamUpdates: true,
    });
    await two.handle(two.msg("hi", "000.9"));
    expect(two.said).toHaveLength(0);
    // one rewrite per message, each with only its own part: nothing posted twice
    const texts = two.updates.map((u) => String(u.text));
    expect(texts.join("")).toBe(head + tail);
    expect(two.updates).toHaveLength(2);
    // the step summary lives on the last message only
    const contexts = two.updates.map((u) => (u.blocks as { type: string }[]).some((b) => b.type === "context"));
    expect(contexts).toEqual([false, true]);
    expect(two.deletes).toHaveLength(0);
  });

  test("a rolled-over message that only held cards is deleted", async () => {
    const big = (id: string): LlmStreamEvent => ({
      type: "tool",
      id,
      title: `run: ${id}`,
      status: "complete",
      details: "d".repeat(250),
    });
    // enough cards to push the allowance over, then a short answer
    const cards = Array.from({ length: 40 }, (_, i) => big(`t${i}`));
    const r = build({
      llm: streamingLlm("done", [{ type: "text", delta: "done" }, ...cards]),
      streamUpdates: true,
    });
    await r.handle(r.msg("hi", "000.9"));
    expect(r.said).toHaveLength(0);
    expect(r.updates.map((u) => String(u.text))).toEqual(["done"]);
    expect(r.deletes.length).toBeGreaterThan(0);
    expect(r.deletes).not.toContain("222.2");
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

  test("a thread the bot opened stays in the thread - broadcast is the owner's reaction", async () => {
    const { handle, msg, updates } = build({
      llm: streamingLlm("hello there", [{ type: "text", delta: "hello there" }]),
      streamUpdates: true,
    });
    await handle(msg("hi"));
    expect(updates).toHaveLength(0);
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

  test("following a thread streams nothing for a note about staying quiet, and posts nothing", async () => {
    const { handle, msg, said, rec } = build({
      llm: streamingLlm("(empty reply — nothing to add here)", [
        { type: "text", delta: "(empty reply — nothing to add here)" },
      ]),
      streamUpdates: true,
    });
    await handle({ ...msg("hi", "000.9"), following: true });
    expect(rec.appends).toHaveLength(0);
    expect(said).toHaveLength(0);
  });

  test("following a thread streams once the turn is plainly working", async () => {
    const { handle, msg, said, rec } = build({
      llm: streamingLlm("fixed the conflicts", [
        { type: "tool", id: "t1", title: "run: gh pr view", status: "in_progress" },
        { type: "text", delta: "fixed the conflicts" },
      ]),
      streamUpdates: true,
    });
    await handle({ ...msg("hi", "000.9"), following: true });
    expect(rec.appends.length).toBeGreaterThan(0);
    expect(said).toHaveLength(0);
  });

  test("following a thread still posts a real answer", async () => {
    const { handle, msg, said } = build({ llm: streamingLlm("the index is missing"), streamUpdates: true });
    await handle({ ...msg("hi", "000.9"), following: true });
    expect(said).toEqual([{ text: "the index is missing" }]);
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

  const card: LlmStreamEvent = { type: "tool", id: "t1", title: "run: git status", status: "complete" };

  test("a streamed note about not replying is taken back, and nothing is posted", async () => {
    const { handle, msg, said, updates, deletes } = build({
      llm: streamingLlm("No response requested.", [card, { type: "text", delta: "No response requested." }]),
      streamUpdates: true,
    });
    await handle(msg("ok", "000.9"));
    expect(deletes).toEqual(["222.2"]);
    expect(updates).toHaveLength(0);
    expect(said).toHaveLength(0);
  });

  test("a turn that showed only cards and wrote nothing never leaves an empty message", async () => {
    const { handle, msg, said, updates, deletes } = build({
      llm: streamingLlm("", [card]),
      streamUpdates: true,
    });
    await handle(msg("ok", "000.9"));
    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ ts: "222.2" });
    expect(String(updates[0]?.text).trim()).not.toBe("");
    expect(said).toHaveLength(0);
  });

  test("a following turn that only looked around and stayed quiet leaves nothing", async () => {
    const { handle, msg, said, updates, deletes } = build({
      llm: streamingLlm("nothing to add", [card, { type: "text", delta: "nothing to add" }]),
      streamUpdates: true,
    });
    await handle({ ...msg("hi", "000.9"), following: true });
    expect(deletes).toEqual(["222.2"]);
    expect(updates).toHaveLength(0);
    expect(said).toHaveLength(0);
  });

  test("an answer that never streamed as text lands on the card message", async () => {
    const big = (id: string): LlmStreamEvent => ({ ...card, id, details: "d".repeat(250) });
    const cards = Array.from({ length: 40 }, (_, i) => big(`t${i}`));
    const r = build({ llm: streamingLlm("the answer", cards), streamUpdates: true });
    await r.handle(r.msg("hi", "000.9"));
    expect(r.updates.map((u) => [u.ts, String(u.text)])).toEqual([["222.2", "the answer"]]);
    expect(r.deletes.length).toBeGreaterThan(0);
    expect(r.deletes).not.toContain("222.2");
    expect(r.said).toHaveLength(0);
  });

  test("a turn that fails after showing cards takes the card message back", async () => {
    const failing: LlmPort = {
      complete: async () => "x",
      stream: async (_p, sink) => {
        sink(card);
        throw new Error("llm down");
      },
    };
    const { handle, msg, said, deletes } = build({ llm: failing, streamUpdates: true });
    await handle(msg("hi", "000.9"));
    expect(deletes).toEqual(["222.2"]);
    expect(said[0]?.text).toContain("error");
  });
});

describe("Block Kit the brain built", () => {
  const rig = (views: Record<string, Record<string, unknown>> = {}, refuse?: string) => {
    const turns: Incoming[] = [];
    const opened: { how: string; args: Record<string, unknown> }[] = [];
    const posted: Record<string, unknown>[] = [];
    const acks: number[] = [];
    const call = (how: string) => async (args: Record<string, unknown>) => {
      if (refuse) throw Object.assign(new Error("boom"), { data: { error: refuse, response_metadata: { messages: ["[ERROR] bad block"] } } });
      opened.push({ how, args });
      return {};
    };
    const client = {
      chat: { postMessage: async (a: Record<string, unknown>) => void posted.push(a) },
      views: { open: call("open"), push: call("push") },
    };
    const { onKitAction, onKitView } = createKitListeners(
      { get: (id) => views[id] },
      async (m) => void turns.push(m),
      () => {},
    );
    const ack = async () => void acks.push(1);
    return { onKitAction, onKitView, turns, opened, posted, acks, client, ack };
  };

  test("a press on a message is acked and becomes a turn in that thread, from whoever pressed", async () => {
    const r = rig();
    await r.onKitAction({
      ack: r.ack,
      client: r.client,
      body: { user: { id: "U2" }, channel: { id: "C1" }, message: { ts: "200.2", thread_ts: "100.1" } },
      action: { action_id: "jv:approve", type: "button", value: "refund-42" },
    });
    expect(r.acks).toHaveLength(1);
    const [turn] = r.turns;
    expect(turn).toMatchObject({ channelId: "C1", threadTs: "100.1", userId: "U2" });
    expect(turn?.text).toContain("`jv:approve`");
    expect(turn?.text).toContain("`refund-42`");
    // never the pressed message's own ts, or the turn reads that message instead
    expect(turn?.messageTs).not.toBe("200.2");
    await turn?.say({ text: "done" });
    expect(r.posted).toEqual([{ channel: "C1", text: "done" }]);
  });

  const choice = [
    { type: "section", text: { type: "mrkdwn", text: "Which?" } },
    { type: "actions", elements: [{ type: "button", action_id: "jv:a", text: { type: "plain_text", text: "Option A" }, value: "a" }] },
  ];

  test("a pressed button locks its message before the turn, naming the choice", async () => {
    const r = rig();
    const updates: Record<string, unknown>[] = [];
    const order: string[] = [];
    const client = { ...r.client, chat: { ...r.client.chat, update: async (a: Record<string, unknown>) => void (updates.push(a), order.push("update")) } };
    const { onKitAction } = createKitListeners(undefined, async () => void order.push("turn"), () => {});
    await onKitAction({
      ack: r.ack,
      client,
      body: { user: { id: "U2" }, channel: { id: "C1" }, message: { ts: "200.2", thread_ts: "100.1", text: "Which?", blocks: choice } },
      action: { action_id: "jv:a", type: "button", value: "a", text: { text: "Option A" } },
    });
    expect(order).toEqual(["update", "turn"]);
    expect(updates[0]).toMatchObject({ channel: "C1", ts: "200.2", text: "Which?" });
    const blocks = updates[0]?.blocks as { type: string; elements?: { text?: string }[] }[];
    expect(blocks.map((b) => b.type)).toEqual(["section", "actions", "context"]);
    expect(JSON.stringify(blocks[1])).toContain("jv:settled:a");
    expect(blocks[2]?.elements?.[0]?.text).toContain("<@U2> chose *Option A*");
  });

  const team = [
    { type: "section", block_id: "heavy", text: { type: "mrkdwn", text: "Pick" }, accessory: { type: "checkboxes", action_id: "jv:team", options: [] } },
    { type: "actions", elements: [{ type: "button", action_id: "jv:deploy", text: { type: "plain_text", text: "Deploy" }, value: "go" }] },
  ];

  test("a checkbox tick next to a button is acked and stays silent", async () => {
    const r = rig();
    await r.onKitAction({
      ack: r.ack,
      client: r.client,
      body: { user: { id: "U2" }, channel: { id: "C1" }, message: { ts: "200.2", thread_ts: "100.1", blocks: team } },
      action: { action_id: "jv:team", type: "checkboxes", block_id: "heavy", selected_options: [{ value: "ironman" }] },
    });
    expect(r.acks).toHaveLength(1);
    expect(r.turns).toHaveLength(0);
  });

  test("the button's turn carries every pick on the message", async () => {
    const r = rig();
    await r.onKitAction({
      ack: r.ack,
      client: { ...r.client, chat: { ...r.client.chat, update: async () => ({}) } },
      body: {
        user: { id: "U2" },
        channel: { id: "C1" },
        message: { ts: "200.2", thread_ts: "100.1", blocks: team },
        state: { values: { heavy: { "jv:team": { type: "checkboxes", selected_options: [{ value: "ironman" }, { value: "thor" }] } } } },
      },
      action: { action_id: "jv:deploy", type: "button", value: "go" },
    });
    expect(r.turns[0]?.text).toContain("`heavy.jv:team`: ironman, thor");
  });

  test("a checkbox with no button on its message is still its own turn", async () => {
    const r = rig();
    await r.onKitAction({
      ack: r.ack,
      client: r.client,
      body: { user: { id: "U2" }, channel: { id: "C1" }, message: { ts: "200.2", thread_ts: "100.1", blocks: [team[0]!] } },
      action: { action_id: "jv:team", type: "checkboxes", selected_options: [{ value: "ironman" }] },
    });
    expect(r.turns).toHaveLength(1);
  });

  test("a press on a settled button is acked and does nothing", async () => {
    const r = rig();
    await r.onKitAction({
      ack: r.ack,
      client: r.client,
      body: { user: { id: "U2" }, channel: { id: "C1" }, message: { ts: "200.2", blocks: choice } },
      action: { action_id: "jv:settled:a", type: "button", value: "a" },
    });
    expect(r.acks).toHaveLength(1);
    expect(r.turns).toHaveLength(0);
  });

  test("unticking a settled checkbox puts the message back as it was settled", async () => {
    const r = rig();
    const updates: Record<string, unknown>[] = [];
    const client = { ...r.client, chat: { ...r.client.chat, update: async (a: Record<string, unknown>) => void updates.push(a) } };
    const boxes = { type: "checkboxes", action_id: "jv:settled:team", options: [], initial_options: [] };
    const settled = [{ type: "actions", block_id: "team", elements: [boxes] }];
    await r.onKitAction({
      ack: r.ack,
      client,
      body: { user: { id: "U2" }, channel: { id: "C1" }, message: { ts: "200.2", text: "Team", blocks: settled } },
      action: { action_id: "jv:settled:team", type: "checkboxes", selected_options: [] },
    });
    // a new block id each time, or Slack keeps the box as the person left it
    expect(updates).toEqual([{ channel: "C1", ts: "200.2", text: "Team", blocks: [{ type: "actions", block_id: "team~", elements: [boxes] }] }]);
    expect(r.turns).toHaveLength(0);

    await r.onKitAction({
      ack: r.ack,
      client,
      body: { user: { id: "U2" }, channel: { id: "C1" }, message: { ts: "200.2", blocks: choice } },
      action: { action_id: "jv:settled:a", type: "button", value: "a" },
    });
    expect(updates).toHaveLength(1);
  });

  const vote = [
    { type: "section", text: { type: "mrkdwn", text: "Quiz" } },
    { type: "actions", block_id: "q1", elements: [
      { type: "button", action_id: "jv:a", text: { type: "plain_text", text: "A" }, value: "a" },
      { type: "button", action_id: "jv:b", text: { type: "plain_text", text: "B" }, value: "b" },
    ] },
    { type: "actions", block_id: "go", elements: [{ type: "button", action_id: "jv:submit", text: { type: "plain_text", text: "Submit" } }] },
  ];

  // U9 opened the thread, U3 asked for the quiz, U1 chatted after it went up.
  const thread = [
    { ts: "100.1", user: "U9", text: "hey" },
    { ts: "200.0", user: "U3", text: "quiz us" },
    { ts: "300.0", user: "UBOT", bot_id: "B1", text: "Quiz" },
    { ts: "310.0", user: "U1", text: "hmm" },
  ];

  test("a vote counts every pick on the message, even at once, and only submit makes a turn", async () => {
    const r = rig();
    const updates: Record<string, unknown>[] = [];
    const client = { ...r.client, conversations: { replies: async () => ({ messages: thread }) },
      chat: { ...r.client.chat, update: async (a: Record<string, unknown>) => {
      await new Promise((ok) => setTimeout(ok, 5));
      updates.push(a);
    } } };
    const press = (user: string, id: string, label: string, blockId: string) =>
      r.onKitAction({
        ack: r.ack,
        client,
        body: { user: { id: user }, channel: { id: "C1" }, message: { ts: "300.0", thread_ts: "100.1", text: "Quiz", blocks: vote } },
        action: { action_id: id, type: "button", block_id: blockId, text: { text: label } },
      });
    await Promise.all([press("U1", "jv:a", "A", "q1"), press("U2", "jv:b", "B", "q1")]);
    expect(r.turns).toHaveLength(0);
    expect(JSON.stringify(updates.at(-1)?.blocks)).toContain("<@U1> *A*   |   <@U2> *B*");
    await press("U3", "jv:submit", "Submit", "go");
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.text).toContain("pressed submit");
    expect(r.turns[0]?.text).toContain("<@U1> A, <@U2> B");
    expect(JSON.stringify(updates.at(-1)?.blocks)).toContain("<@U3> submitted");
  });

  test("only the thread owner or the person asked may submit a vote, others are told privately", async () => {
    const r = rig();
    const updates: Record<string, unknown>[] = [];
    const whispers: Record<string, unknown>[] = [];
    const client = { ...r.client, conversations: { replies: async () => ({ messages: thread }) },
      chat: { ...r.client.chat, update: async (a: Record<string, unknown>) => void updates.push(a),
        postEphemeral: async (a: Record<string, unknown>) => void whispers.push(a) } };
    const submit = (user: string) =>
      r.onKitAction({
        ack: r.ack,
        client,
        body: { user: { id: user }, channel: { id: "C1" }, message: { ts: "300.0", thread_ts: "100.1", text: "Quiz", blocks: vote } },
        action: { action_id: "jv:submit", type: "button", block_id: "go", text: { text: "Submit" } },
      });
    await submit("U1");
    expect(r.turns).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(whispers[0]).toMatchObject({ channel: "C1", user: "U1", thread_ts: "100.1" });
    expect(whispers[0]?.text).toContain("only <@U9> or <@U3> can submit");
    await submit("U9");
    expect(r.turns).toHaveLength(1);
  });

  test("a vote stays open when the submit check cannot read the thread", async () => {
    const r = rig();
    const whispers: Record<string, unknown>[] = [];
    const client = { ...r.client, conversations: { replies: async () => { throw new Error("ratelimited"); } },
      chat: { ...r.client.chat, update: async () => undefined, postEphemeral: async (a: Record<string, unknown>) => void whispers.push(a) } };
    await r.onKitAction({
      ack: r.ack,
      client,
      body: { user: { id: "U9" }, channel: { id: "C1" }, message: { ts: "300.0", thread_ts: "100.1", text: "Quiz", blocks: vote } },
      action: { action_id: "jv:submit", type: "button", block_id: "go", text: { text: "Submit" } },
    });
    expect(r.turns).toHaveLength(0);
    expect(whispers[0]?.text).toContain("could not check");
  });

  test("a typed reply leaves an open vote alone", async () => {
    const updates: unknown[] = [];
    const client = {
      conversations: { replies: async () => ({ messages: [{ ts: "150.0", user: "UBOT", text: "Quiz", blocks: vote }] }) },
      chat: { update: async (a: unknown) => void updates.push(a) },
    };
    expect(await retireOpenKit(client, "UBOT", { channel: "C1", ts: "200.0", thread_ts: "100.1", user: "U1" }, () => {})).toBe(0);
    expect(updates).toHaveLength(0);
  });

  test("a checkbox press leaves the message live and waits for its button", async () => {
    const updates: unknown[] = [];
    const r = rig();
    const client = { ...r.client, chat: { ...r.client.chat, update: async (a: unknown) => void updates.push(a) } };
    await r.onKitAction({
      ack: r.ack,
      client,
      body: { user: { id: "U2" }, channel: { id: "C1" }, message: { ts: "200.2", blocks: choice } },
      action: { action_id: "jv:a", type: "checkboxes", selected_options: [{ value: "a" }] },
    });
    expect(updates).toHaveLength(0);
    expect(r.turns).toHaveLength(0);
  });

  test("a failed lock still hands the press to the thread", async () => {
    const r = rig();
    const client = { ...r.client, chat: { ...r.client.chat, update: async () => { throw new Error("cant_update_message"); } } };
    await r.onKitAction({
      ack: r.ack,
      client,
      body: { user: { id: "U2" }, channel: { id: "C1" }, message: { ts: "200.2", blocks: choice } },
      action: { action_id: "jv:a", type: "button", value: "a" },
    });
    expect(r.turns).toHaveLength(1);
  });

  test("a typed reply retires our open questions earlier in the thread, nothing else", async () => {
    const updates: Record<string, unknown>[] = [];
    const client = {
      conversations: {
        replies: async () => ({
          messages: [
            { ts: "100.1", user: "U1", text: "hi" },
            { ts: "150.0", user: "UBOT", text: "Which?", blocks: choice },
            { ts: "160.0", user: "UBOT", text: "plain" },
            { ts: "170.0", user: "UOTHER", text: "theirs", blocks: choice },
            { ts: "300.0", user: "UBOT", text: "later", blocks: choice },
          ],
        }),
      },
      chat: { update: async (a: Record<string, unknown>) => void updates.push(a) },
    };
    const n = await retireOpenKit(client, "UBOT", { channel: "D1", ts: "200.0", thread_ts: "100.1", user: "U1" }, () => {});
    expect(n).toBe(1);
    expect(updates[0]).toMatchObject({ channel: "D1", ts: "150.0", text: "Which?" });
    expect(JSON.stringify(updates[0]?.blocks)).toContain("<@U1> answered in the thread");
  });

  test("a top-level message or an unknown bot id looks nothing up", async () => {
    let calls = 0;
    const client = { conversations: { replies: async () => (calls++, { messages: [] }) }, chat: { update: async () => {} } };
    expect(await retireOpenKit(client, "UBOT", { channel: "D1", ts: "1.0", user: "U1" }, () => {})).toBe(0);
    expect(await retireOpenKit(client, undefined, { channel: "D1", ts: "2.0", thread_ts: "1.0", user: "U1" }, () => {})).toBe(0);
    expect(calls).toBe(0);
  });

  test("a top-level message is its own thread", async () => {
    const r = rig();
    await r.onKitAction({
      ack: r.ack,
      client: r.client,
      body: { user: { id: "U2" }, channel: { id: "C1" }, message: { ts: "200.2" } },
      action: { action_id: "jv:pick", type: "static_select", selected_option: { value: "p1" } },
    });
    expect(r.turns[0]?.threadTs).toBe("200.2");
    expect(r.turns[0]?.text).toContain("`p1`");
  });

  test("a modal button opens the stored view, routed home, without a turn", async () => {
    const r = rig({ abc: { title: { type: "plain_text", text: "Ticket" }, blocks: [] } });
    await r.onKitAction({
      ack: r.ack,
      client: r.client,
      body: { user: { id: "U2" }, trigger_id: "T1", channel: { id: "C1" }, message: { ts: "200.2", thread_ts: "100.1" } },
      action: { action_id: "jv:modal:abc", type: "button" },
    });
    expect(r.turns).toHaveLength(0);
    expect(r.opened).toHaveLength(1);
    const { how, args } = r.opened[0]!;
    expect(how).toBe("open");
    const view = args.view as Record<string, unknown>;
    expect(args.trigger_id).toBe("T1");
    expect(view.callback_id).toBe("jv:view:abc");
    expect(String(view.private_metadata)).toContain("100.1");
  });

  test("a modal button inside a modal stacks the next one", async () => {
    const r = rig({ abc: { title: { type: "plain_text", text: "Step 2" }, blocks: [] } });
    await r.onKitAction({
      ack: r.ack,
      client: r.client,
      body: { user: { id: "U2" }, trigger_id: "T1", view: { private_metadata: '{"c":"C1","t":"100.1"}' } },
      action: { action_id: "jv:modal:abc", type: "button" },
    });
    expect(r.opened[0]?.how).toBe("push");
  });

  test("a modal Slack refuses comes back to the thread with Slack's reason", async () => {
    const r = rig({ abc: { title: { type: "plain_text", text: "T" }, blocks: [] } }, "invalid_arguments");
    await r.onKitAction({
      ack: r.ack,
      client: r.client,
      body: { user: { id: "U2" }, trigger_id: "T1", channel: { id: "C1" }, message: { ts: "200.2" } },
      action: { action_id: "jv:modal:abc", type: "button" },
    });
    expect(r.turns[0]?.text).toContain("invalid_arguments");
    expect(r.turns[0]?.text).toContain("bad block");
  });

  test("a modal that was never stored says so rather than doing nothing", async () => {
    const r = rig();
    await r.onKitAction({
      ack: r.ack,
      client: r.client,
      body: { user: { id: "U2" }, trigger_id: "T1", channel: { id: "C1" }, message: { ts: "200.2" } },
      action: { action_id: "jv:modal:gone", type: "button" },
    });
    expect(r.turns[0]?.text).toContain("not stored");
  });

  test("a submission becomes a turn in the thread it came from, listing the fields", async () => {
    const r = rig();
    await r.onKitView({
      ack: r.ack,
      client: r.client,
      body: { type: "view_submission", user: { id: "U2" } },
      view: {
        callback_id: "jv:view:abc",
        title: { text: "Ticket app" },
        private_metadata: '{"c":"C1","t":"100.1","m":"t-9"}',
        state: { values: { title: { input: { type: "plain_text_input", value: "login broken" } } } },
      },
    });
    expect(r.acks).toHaveLength(1);
    expect(r.turns[0]).toMatchObject({ channelId: "C1", threadTs: "100.1", userId: "U2" });
    expect(r.turns[0]?.text).toContain("- `title.input`: login broken");
    expect(r.turns[0]?.text).toContain("`t-9`");
  });

  test("a close is reported, and a view with no thread is acked and dropped", async () => {
    const r = rig();
    await r.onKitView({
      ack: r.ack,
      client: r.client,
      body: { type: "view_closed", user: { id: "U2" } },
      view: { callback_id: "jv:view:abc", private_metadata: '{"c":"C1","t":"100.1"}' },
    });
    await r.onKitView({
      ack: r.ack,
      client: r.client,
      body: { type: "view_submission", user: { id: "U2" } },
      view: { callback_id: "jv:x" },
    });
    expect(r.acks).toHaveLength(2);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.text).toContain("closed the modal");
  });
});
