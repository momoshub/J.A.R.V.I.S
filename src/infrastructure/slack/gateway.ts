/**
 * The Slack gateway: holds the Socket Mode connection and nothing else.
 *
 * It acks each envelope and writes it to the inbox, and the bot reads it from
 * there. No business logic, no model, no commands - so a code change to the
 * bot never needs this process restarted, and Slack never sees us go away.
 *
 * Kept deliberately small and dependency-light: the less it imports, the less
 * a change elsewhere can force a restart of the one piece that must stay up.
 */
import { SocketModeClient } from "@slack/socket-mode";
import {
  CONNECTION_GRACE_MS,
  describeConnection,
  shouldGiveUp,
  type ConnectionHealth,
  type ConnectionState,
} from "../../domain/connectionHealth.ts";
import { ACK_WAIT_MS, isEnvelopeType, waitsForAck } from "../../domain/inbox.ts";
import type { InboxRepo } from "../inbox/inboxRepo.ts";

/** What the socket client hands us per envelope. */
export type SocketEnvelope = {
  ack: (response?: Record<string, unknown>) => Promise<void>;
  envelope_id: string;
  type: string;
  body: unknown;
  retry_num?: number;
  retry_reason?: string;
};

export type GatewayHandlerDeps = {
  readonly inbox: InboxRepo;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly ackWaitMs?: number;
  readonly ackPollMs?: number;
  readonly log?: (line: string) => void;
};

/**
 * Store, then ack. Stored first so an ack always means "we have it": acking
 * and then failing the write is the one way left to lose a message.
 *
 * An event is acked at once. An interactive payload or slash command waits a
 * moment for the bot's own ack, because that ack can carry a response - a
 * modal's field errors - and passes it on. A bot that is down or slow gets an
 * empty ack instead, and handles the row when it is back.
 */
export const createGatewayHandler = (deps: GatewayHandlerDeps) => {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((l: string) => console.log(`[gateway] ${l}`));
  const waitMs = deps.ackWaitMs ?? ACK_WAIT_MS;
  const pollMs = deps.ackPollMs ?? 25;

  return async (e: SocketEnvelope): Promise<void> => {
    if (!isEnvelopeType(e.type)) {
      await e.ack();
      return;
    }
    let id: number | undefined;
    try {
      id = deps.inbox.enqueue(
        { envelopeId: e.envelope_id, type: e.type, body: e.body, retryNum: e.retry_num, retryReason: e.retry_reason },
        now(),
      );
    } catch (err) {
      // Not acked: Slack retries an event it did not hear back about, which
      // is a better outcome than an ack for a message nobody stored.
      log(`could not store ${e.type} ${e.envelope_id}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (id === undefined || !waitsForAck(e.type)) {
      await e.ack();
      return;
    }
    const deadline = now() + waitMs;
    while (now() < deadline) {
      const reply = deps.inbox.ackFor(id);
      if (reply) {
        await e.ack(reply.payload);
        return;
      }
      await sleep(pollMs);
    }
    log(`no ack from the bot for ${e.type} row ${id} - acked empty, it will be handled when the bot is back`);
    await e.ack();
  };
};

export type GatewayConfig = {
  readonly appToken: string;
  readonly inbox: InboxRepo;
  readonly graceMs?: number;
  readonly beatMs?: number;
  readonly log?: (line: string) => void;
};

/** Open the socket, beat, and exit if it goes deaf so launchd restarts us. */
export const startGateway = async (config: GatewayConfig) => {
  const log = config.log ?? ((l: string) => console.log(`[gateway] ${l}`));
  const client = new SocketModeClient({ appToken: config.appToken });
  const health: ConnectionHealth = { state: "unknown", since: Date.now() };

  const beat = () => {
    try {
      config.inbox.heartbeat({ state: health.state, since: health.since, beatAt: Date.now(), pid: process.pid });
    } catch (err) {
      log(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const enter = (state: ConnectionState): void => {
    if (health.state === state) return;
    health.state = state;
    health.since = Date.now();
    log(`socket ${state}`);
    beat();
  };
  client.on("connected", () => enter("connected"));
  client.on("connecting", () => enter("connecting"));
  client.on("reconnecting", () => enter("reconnecting"));
  client.on("disconnecting", () => enter("disconnected"));
  client.on("disconnected", () => enter("disconnected"));

  const handle = createGatewayHandler({ inbox: config.inbox, log });
  client.on("slack_event", (e: SocketEnvelope) => {
    enter("connected");
    void handle(e).catch((err: unknown) => log(`envelope failed: ${err instanceof Error ? err.message : String(err)}`));
  });

  await client.start();
  if (health.state === "unknown") enter("connected");

  const graceMs = config.graceMs ?? CONNECTION_GRACE_MS;
  const timer = setInterval(() => {
    beat();
    if (shouldGiveUp(health, Date.now(), graceMs)) {
      log(`giving up: ${describeConnection(health, Date.now())}. Exiting so the supervisor restarts me.`);
      process.exit(1);
    }
  }, config.beatMs ?? 5_000);

  log("listening via Socket Mode, writing to the inbox");
  return {
    stop: async () => {
      clearInterval(timer);
      enter("disconnected");
      await client.disconnect();
    },
  };
};
