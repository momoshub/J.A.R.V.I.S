import { describe, expect, test } from "bun:test";
import {
  dedupeKeyOf,
  gatewayHealth,
  HEARTBEAT_STALE_MS,
  MAX_ATTEMPTS,
  PENDING_MAX_AGE_MS,
  recoveryFor,
  REDELIVER_MAX_AGE_MS,
  waitsForAck,
} from "../../src/domain/inbox.ts";
import { openInbox } from "../../src/infrastructure/inbox/inboxRepo.ts";
import {
  createInboxReceiver,
  tidyInterrupted,
  type ApiCaller,
  type EventProcessor,
} from "../../src/infrastructure/slack/inboxReceiver.ts";
import { interruptedNotice } from "../../src/domain/inbox.ts";
import { interruptedRules } from "../../src/domain/personality.ts";
import { createSlackStream, type Streamer } from "../../src/infrastructure/slack/stream.ts";
import { createHandler, type SlackAppConfig, type SlackClient } from "../../src/infrastructure/slack/app.ts";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import type { LlmPort } from "../../src/application/ports.ts";
import { createGatewayHandler, type SocketEnvelope } from "../../src/infrastructure/slack/gateway.ts";

const T0 = 1_800_000_000_000;
const message = (eventId: string, text = "hi") => ({
  type: "event_callback",
  event_id: eventId,
  event: { type: "message", channel: "D1", user: "U1", text, ts: "1.1", channel_type: "im" },
});

describe("inbox rules", () => {
  test("a retried event dedupes on its event id, not the new envelope", () => {
    expect(dedupeKeyOf("env-1", { event_id: "Ev1" })).toBe(dedupeKeyOf("env-2", { event_id: "Ev1" }));
  });
  test("a payload with no event id dedupes on its envelope", () => {
    expect(dedupeKeyOf("env-1", { type: "block_actions" })).toBe("envelope:env-1");
  });
  test("only interactive and slash envelopes wait for the bot's ack", () => {
    expect(waitsForAck("events_api")).toBe(false);
    expect(waitsForAck("interactive")).toBe(true);
    expect(waitsForAck("slash_commands")).toBe(true);
  });
  test("an interrupted row is redelivered while fresh and under its attempts", () => {
    expect(recoveryFor({ receivedAt: T0, attempts: 1 }, T0 + 60_000)).toBe("redeliver");
    expect(recoveryFor({ receivedAt: T0, attempts: MAX_ATTEMPTS }, T0 + 60_000)).toBe("drop");
    expect(recoveryFor({ receivedAt: T0, attempts: 1 }, T0 + REDELIVER_MAX_AGE_MS + 1)).toBe("drop");
  });
  test("a stale heartbeat means disconnected, whatever the row last said", () => {
    const s = { state: "connected" as const, since: T0, beatAt: T0 };
    expect(gatewayHealth(s, T0 + 1_000).state).toBe("connected");
    expect(gatewayHealth(s, T0 + HEARTBEAT_STALE_MS + 1)).toEqual({ state: "disconnected", since: T0 });
    expect(gatewayHealth(undefined, T0).state).toBe("unknown");
  });
});

describe("inbox repo", () => {
  test("enqueue ignores a duplicate and claims in arrival order, once", () => {
    const inbox = openInbox(":memory:");
    const a = inbox.enqueue({ envelopeId: "e1", type: "events_api", body: message("Ev1") }, T0);
    expect(inbox.enqueue({ envelopeId: "e2", type: "events_api", body: message("Ev1") }, T0)).toBeUndefined();
    const b = inbox.enqueue({ envelopeId: "e3", type: "events_api", body: message("Ev2") }, T0);
    const claimed = inbox.claim(10, T0);
    expect(claimed.map((r) => r.id)).toEqual([a!, b!]);
    expect(claimed[0]!.body).toEqual(message("Ev1"));
    expect(inbox.claim(10, T0)).toEqual([]);
  });

  test("an ack is visible to the gateway, with or without a payload", () => {
    const inbox = openInbox(":memory:");
    const id = inbox.enqueue({ envelopeId: "e1", type: "interactive", body: {} }, T0)!;
    expect(inbox.ackFor(id)).toBeUndefined();
    inbox.recordAck(id, { response_action: "errors" }, T0);
    expect(inbox.ackFor(id)).toEqual({ payload: { response_action: "errors" } });
    const other = inbox.enqueue({ envelopeId: "e2", type: "interactive", body: {} }, T0)!;
    inbox.recordAck(other, undefined, T0);
    expect(inbox.ackFor(other)).toEqual({});
  });

  test("recover puts fresh interrupted rows back and drops the rest", () => {
    const inbox = openInbox(":memory:");
    inbox.enqueue({ envelopeId: "e1", type: "events_api", body: message("Ev1") }, T0);
    inbox.enqueue({ envelopeId: "e2", type: "events_api", body: message("Ev2") }, T0 - PENDING_MAX_AGE_MS - 1);
    inbox.claim(1, T0);
    expect(inbox.recover(T0 + 1_000)).toEqual({ redelivered: 1, dropped: 1, interrupted: [] });
    expect(inbox.counts()).toMatchObject({ pending: 1, running: 0, dropped: 1 });
  });

  test("the gateway heartbeat round-trips", () => {
    const inbox = openInbox(":memory:");
    expect(inbox.gateway()).toBeUndefined();
    inbox.heartbeat({ state: "connected", since: T0, beatAt: T0 + 5, pid: 42 });
    inbox.heartbeat({ state: "reconnecting", since: T0 + 9, beatAt: T0 + 10, pid: 42 });
    expect(inbox.gateway()).toEqual({ state: "reconnecting", since: T0 + 9, beatAt: T0 + 10, pid: 42 });
  });
});

describe("inbox receiver", () => {
  test("hands every claimed row to Bolt and settles it", async () => {
    const inbox = openInbox(":memory:");
    inbox.enqueue({ envelopeId: "e1", type: "events_api", body: message("Ev1") }, T0);
    inbox.enqueue({ envelopeId: "e2", type: "events_api", body: message("Ev2") }, T0);
    const seen: unknown[] = [];
    const app: EventProcessor = {
      processEvent: async (e) => {
        seen.push(e.body);
        if ((e.body as { event_id?: string }).event_id === "Ev2") throw new Error("boom");
      },
    };
    const receiver = createInboxReceiver({ inbox, now: () => T0, log: () => undefined });
    receiver.init(app);
    await Promise.all(receiver.drain());
    expect(seen).toEqual([message("Ev1"), message("Ev2")]);
    expect(inbox.counts()).toMatchObject({ done: 1, failed: 1, pending: 0, running: 0 });
    expect(receiver.inFlight()).toBe(0);
  });

  test("a row stays in flight until its handler finishes, so a restart waits for it", async () => {
    const inbox = openInbox(":memory:");
    inbox.enqueue({ envelopeId: "e1", type: "events_api", body: message("Ev1") }, T0);
    let release = () => undefined as void;
    const app: EventProcessor = { processEvent: () => new Promise<void>((r) => (release = r)) };
    const receiver = createInboxReceiver({ inbox, now: () => T0, log: () => undefined });
    receiver.init(app);
    const [done] = receiver.drain();
    expect(receiver.inFlight()).toBe(1);
    release();
    await done;
    expect(receiver.inFlight()).toBe(0);
  });

  test("the ack Bolt gives is recorded for the gateway", async () => {
    const inbox = openInbox(":memory:");
    const id = inbox.enqueue({ envelopeId: "e1", type: "interactive", body: { type: "view_submission" } }, T0)!;
    const app: EventProcessor = { processEvent: async (e) => void (await e.ack({ response_action: "errors" })) };
    const receiver = createInboxReceiver({ inbox, now: () => T0, log: () => undefined });
    receiver.init(app);
    await Promise.all(receiver.drain());
    expect(inbox.ackFor(id)).toEqual({ payload: { response_action: "errors" } });
  });
});

describe("gateway handler", () => {
  const envelope = (type: string, body: unknown, acks: unknown[]): SocketEnvelope => ({
    envelope_id: `env-${acks.length}-${Math.random()}`,
    type,
    body,
    ack: async (r) => void acks.push(r ?? "empty"),
  });

  test("stores an event, then acks it at once", async () => {
    const inbox = openInbox(":memory:");
    const acks: unknown[] = [];
    await createGatewayHandler({ inbox, log: () => undefined })(envelope("events_api", message("Ev1"), acks));
    expect(acks).toEqual(["empty"]);
    expect(inbox.counts().pending).toBe(1);
  });

  test("passes the bot's ack payload through for an interactive envelope", async () => {
    const inbox = openInbox(":memory:");
    const acks: unknown[] = [];
    let clock = T0;
    const handle = createGatewayHandler({
      inbox,
      now: () => clock,
      // The bot answers while the gateway is waiting.
      sleep: async (ms) => {
        clock += ms;
        const [row] = inbox.claim(1, clock);
        if (row) inbox.recordAck(row.id, { response_action: "errors" }, clock);
      },
      log: () => undefined,
    });
    await handle(envelope("interactive", { type: "view_submission" }, acks));
    expect(acks).toEqual([{ response_action: "errors" }]);
  });

  test("acks empty when the bot does not answer in time, and keeps the row", async () => {
    const inbox = openInbox(":memory:");
    const acks: unknown[] = [];
    let clock = T0;
    const handle = createGatewayHandler({
      inbox,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      log: () => undefined,
    });
    await handle(envelope("slash_commands", { command: "/jv" }, acks));
    expect(acks).toEqual(["empty"]);
    expect(inbox.counts().pending).toBe(1);
  });

  test("never acks what it could not store, so Slack retries it", async () => {
    const inbox = {
      ...openInbox(":memory:"),
      enqueue: () => {
        throw new Error("database is locked");
      },
    };
    const acks: unknown[] = [];
    await createGatewayHandler({ inbox, log: () => undefined })(envelope("events_api", message("Ev1"), acks));
    expect(acks).toEqual([]);
  });

  test("acks and skips an envelope type it does not store", async () => {
    const inbox = openInbox(":memory:");
    const acks: unknown[] = [];
    await createGatewayHandler({ inbox, log: () => undefined })(envelope("hello", {}, acks));
    expect(acks).toEqual(["empty"]);
    expect(inbox.counts().pending).toBe(0);
  });
});

describe("a reply cut off by a restart", () => {
  test("recover reports the streams a dead row opened, and forgets them on redelivery", () => {
    const inbox = openInbox(":memory:");
    const fresh = inbox.enqueue({ envelopeId: "e1", type: "events_api", body: message("Ev1") }, T0)!;
    const old = inbox.enqueue({ envelopeId: "e2", type: "events_api", body: message("Ev2") }, T0 - 60 * 60_000)!;
    inbox.claim(10, T0);
    inbox.addStream(fresh, "D1", "300.1");
    inbox.addStream(fresh, "D1", "300.2");
    inbox.addStream(old, "C9", "400.1");
    const { interrupted } = inbox.recover(T0 + 1_000);
    expect(interrupted).toEqual([
      { id: fresh, channel: "D1", streamTs: ["300.1", "300.2"], outcome: "redeliver" },
      { id: old, channel: "C9", streamTs: ["400.1"], outcome: "drop" },
    ]);
    // The retry is reclaimed and dies again: only ITS streams are reported,
    // never the first attempt's a second time.
    inbox.claim(10, T0 + 2_000);
    expect(inbox.recover(T0 + 3_000).interrupted).toEqual([]);
  });

  test("the receiver tidies before it hands out the retry, and tells Bolt which attempt it is", async () => {
    const inbox = openInbox(":memory:");
    const id = inbox.enqueue({ envelopeId: "e1", type: "events_api", body: message("Ev1") }, T0)!;
    inbox.claim(1, T0);
    inbox.addStream(id, "D1", "300.1");
    const order: string[] = [];
    const contexts: unknown[] = [];
    const receiver = createInboxReceiver({
      inbox,
      now: () => T0 + 1_000,
      pollMs: 60_000,
      log: () => undefined,
      onInterrupted: async (row) => void order.push(`tidy ${row.streamTs.join(",")} ${row.outcome}`),
    });
    receiver.init({
      processEvent: async (e) => {
        order.push("dispatch");
        contexts.push(e.customProperties);
      },
    });
    await receiver.start();
    await receiver.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["tidy 300.1 redeliver", "dispatch"]);
    expect(contexts).toEqual([{ inboxRowId: id, inboxAttempt: 2 }]);
  });

  test("tidying stops every stream, rewrites the first and deletes the rest", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const api: ApiCaller = {
      apiCall: async (method, args) => {
        calls.push([method, args]);
        // Slack already timed this one out; the rewrite must still happen.
        if (method === "chat.stopStream" && args.ts === "300.1") throw new Error("message_not_in_streaming_state");
        return { ok: true };
      },
    };
    const notice = interruptedNotice("redeliver");
    await tidyInterrupted(api, { id: 1, channel: "D1", streamTs: ["300.1", "300.2"], outcome: "redeliver" }, notice);
    expect(calls).toEqual([
      ["chat.stopStream", { channel: "D1", ts: "300.1" }],
      ["chat.update", { channel: "D1", ts: "300.1", text: notice, blocks: [{ type: "markdown", text: notice }] }],
      ["chat.stopStream", { channel: "D1", ts: "300.2" }],
      ["chat.delete", { channel: "D1", ts: "300.2" }],
    ]);
  });

  test("a stream reports each message it opens, once", async () => {
    const opened: string[] = [];
    let n = 0;
    const stream = createSlackStream(
      (): Streamer => {
        const ts = `500.${++n}`;
        return { append: async () => undefined, stop: async () => undefined, ts };
      },
      () => undefined,
      "done",
      { onOpen: (ts) => opened.push(ts) },
    );
    stream.sink({ type: "text", delta: "one" });
    stream.sink({ type: "text", delta: " two" });
    await stream.finish();
    expect(opened).toEqual(["500.1"]);
  });

  test("only a retry is told it was cut off", () => {
    expect(interruptedRules(false)).toBe("");
    expect(interruptedRules(true)).toContain("check what the first attempt already did");
  });

  test("the handler records the stream against its row and tells a retry's prompt", async () => {
    const db = openDatabase(":memory:");
    const users = createUserRepo(db);
    users.upsert({ slackId: "U1", role: "owner", displayName: "K", addedBy: "system", createdAt: 1 });
    const systems: string[] = [];
    const llm: LlmPort = {
      complete: async () => "ok",
      stream: async (p, sink) => {
        systems.push(p.system);
        sink({ type: "text", delta: "answer" });
        return "answer";
      },
    };
    const recorded: [number, string, string][] = [];
    const inboxReceiver = {
      ...createInboxReceiver({ inbox: openInbox(":memory:"), log: () => undefined }),
      recordStream: (rowId: number, channel: string, ts: string) => void recorded.push([rowId, channel, ts]),
    };
    const config: SlackAppConfig = {
      botToken: "x",
      appToken: "x",
      streamUpdates: true,
      botName: "Bot",
      thinkingLabel: () => "..",
      thinkingDoneLabel: () => "done",
      commandPrefix: "//bot",
      slashCommand: "/bot",
      inbox: inboxReceiver,
    };
    const client: SlackClient = {
      users: { info: async () => ({ user: { profile: { display_name: "K" } } }) },
      chatStream: () => ({ append: async () => undefined, stop: async () => undefined, ts: "600.1" }),
      chat: { update: async () => ({}) },
    };
    const handle = createHandler(
      config,
      { users, messages: createMessageRepo(db), llm, clock: () => 1, ownerSlackId: "U1" },
      () => undefined,
    );
    const base = { channelId: "D1", userId: "U1", text: "hi", messageTs: "111.1", client, say: async () => ({}) };
    await handle({ ...base, threadTs: "111.1", inbox: { rowId: 7, attempt: 1 } });
    await handle({ ...base, threadTs: "112.1", messageTs: "112.1", inbox: { rowId: 8, attempt: 2 } });
    expect(recorded).toEqual([
      [7, "D1", "600.1"],
      [8, "D1", "600.1"],
    ]);
    expect(systems[0]).not.toContain("handled a SECOND time");
    expect(systems[1]).toContain("handled a SECOND time");
  });
});
