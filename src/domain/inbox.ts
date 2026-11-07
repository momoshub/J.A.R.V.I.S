/**
 * The inbox between the Slack gateway and the bot.
 *
 * Listening and thinking used to be one process, so every restart to pick up
 * a code change dropped the socket, and whatever Slack sent in that window was
 * gone. Now a small gateway holds the socket, acks, and writes each envelope to
 * a durable queue; the bot reads the queue. The gateway almost never changes,
 * so it almost never restarts, and a bot restart only means the queue waits.
 *
 * The rules that decide what happens to a row live here, with no I/O.
 */
import type { ConnectionHealth, ConnectionState } from "./connectionHealth.ts";

/** pending -> running -> done | failed, or dropped when it is too old to act on. */
export type InboxState = "pending" | "running" | "done" | "failed" | "dropped";

/** The Socket Mode envelope types the gateway stores. */
export type EnvelopeType = "events_api" | "interactive" | "slash_commands";

export const ENVELOPE_TYPES: readonly EnvelopeType[] = ["events_api", "interactive", "slash_commands"];

export const isEnvelopeType = (t: string): t is EnvelopeType => (ENVELOPE_TYPES as readonly string[]).includes(t);

/**
 * How long the gateway holds an interactive ack open for the bot to answer it.
 *
 * Slack wants an ack within 3 seconds. An event needs nothing back, but a
 * modal submission does - `response_action: errors` is how a mistyped token is
 * shown on the field instead of the modal closing on it - so the gateway waits
 * for the bot's ack and gives up just short of Slack's limit.
 */
export const ACK_WAIT_MS = 2_500;

/**
 * Attempts a row gets before it is given up on. A row the bot was running
 * when it died is retried at once the first time, and after `RETRY_DELAY_MS`
 * every time after that: a second cut-off usually means something is still
 * going on - a git operation swapping the database out, a deploy, the message
 * itself - and five minutes lets it settle instead of walking straight back
 * into it. The cap is what stops a message that crashes the bot every time
 * from becoming a crash loop.
 */
export const MAX_ATTEMPTS = 4;

/** How long a row cut off more than once waits before it runs again. */
export const RETRY_DELAY_MS = 5 * 60_000;

/** What recovery does with a row it finds `running`. */
export type Recovery = "redeliver" | "defer" | "drop";

/**
 * A row older than this is not worth acting on any more. A reply hours late to
 * a message somebody has long since given up on reads as a malfunction, and a
 * button's trigger_id died seconds after it was pressed.
 */
export const REDELIVER_MAX_AGE_MS = 15 * 60_000;
export const PENDING_MAX_AGE_MS = 24 * 60 * 60_000;

/** Finished rows are kept this long, for "did it ever arrive" questions. */
export const KEEP_FINISHED_MS = 7 * 24 * 60 * 60_000;

/** A gateway that has not written a heartbeat for this long is not listening. */
export const HEARTBEAT_STALE_MS = 30_000;

/**
 * The key that makes a retried envelope a no-op.
 *
 * Slack redelivers an event it thinks was not acked, under a NEW envelope id
 * but the same `event_id`. Interactive payloads and slash commands have no
 * event id and are not retried, so their envelope is the key.
 */
export const dedupeKeyOf = (envelopeId: string, body: unknown): string => {
  const eventId =
    typeof body === "object" && body !== null && "event_id" in body ? (body as { event_id?: unknown }).event_id : undefined;
  return typeof eventId === "string" && eventId ? `event:${eventId}` : `envelope:${envelopeId}`;
};

/** Only interactive payloads and slash commands can carry a response in their ack. */
export const waitsForAck = (type: EnvelopeType): boolean => type !== "events_api";

/**
 * What to do with a row found `running` when the bot starts. Its age counts
 * from the last attempt, not from when it arrived: a message still being
 * worked on is not stale, however many restarts it has been through.
 *
 * A row cut by a PLANNED restart (`cutAt`, set just before a restart that ran
 * out of waiting) is different: the cause is known and already gone, so it is
 * redelivered at once rather than deferred, and its age counts from the cut -
 * a turn that had been running for forty minutes is exactly the one somebody
 * is still waiting on.
 */
export const recoveryFor = (
  row: { receivedAt: number; claimedAt?: number; attempts: number; cutAt?: number },
  now: number,
): Recovery => {
  if (row.attempts >= MAX_ATTEMPTS) return "drop";
  if (row.cutAt !== undefined) return now - row.cutAt > REDELIVER_MAX_AGE_MS ? "drop" : "redeliver";
  if (now - (row.claimedAt ?? row.receivedAt) > REDELIVER_MAX_AGE_MS) return "drop";
  return row.attempts <= 1 ? "redeliver" : "defer";
};

/**
 * Whether the bot can hear Slack, read from the gateway's heartbeat.
 *
 * The socket lives in another process now, so its state is only as good as
 * the last thing that process wrote. A gateway that died mid-"connected"
 * leaves a row saying connected forever - so a stale heartbeat overrides it,
 * and counts as away from the moment the beats stopped.
 */
export const gatewayHealth = (
  s: { state: ConnectionState; since: number; beatAt: number } | undefined,
  now: number,
): ConnectionHealth => {
  if (!s) return { state: "unknown", since: now };
  if (now - s.beatAt > HEARTBEAT_STALE_MS) return { state: "disconnected", since: s.beatAt };
  return { state: s.state, since: s.since };
};

/**
 * What a half-written reply is replaced with after a restart cut it off.
 * The half is not worth keeping: a retry answers in full below it, and a
 * dropped row's half is an answer that stops mid-sentence.
 */
export const interruptedNotice = (outcome: Recovery, retried = false): string =>
  outcome === "redeliver"
    ? "⚠️ _a restart cut this reply off - picking it up again below_"
    : outcome === "defer"
      ? `⚠️ _a restart cut this reply off again - giving things ${RETRY_DELAY_MS / 60_000} minutes to settle, then picking it up again below_`
      : retried
        ? // Cut off on every attempt: the likeliest cause is the message
          // itself, and running it once more unattended is how a crash
          // becomes a loop.
          `⚠️ _a restart cut this reply off ${MAX_ATTEMPTS} times, so I am not retrying it on my own - it may be what is crashing me. Ask me once more if it is safe to_`
        : "⚠️ _a restart cut this reply off, and it was too long ago to pick up again - ask me once more_";
