/**
 * A Bolt receiver that reads the gateway's inbox instead of a socket.
 *
 * Bolt does not care where an envelope came from: a receiver hands it a body
 * and an ack, and every listener in `app.ts` runs exactly as it did over
 * Socket Mode - same say, same respond, same client. So the split is this one
 * file, and nothing that handles a message had to change.
 *
 * Each claimed row is dispatched without waiting on the ones before it, the
 * same as the socket did: a long turn in one thread must not hold up another.
 * Order within a thread is still kept, because rows are dispatched in arrival
 * order and the thread queue in `respond` serialises from there.
 */
import type { ConnectionHealth } from "../../domain/connectionHealth.ts";
import { gatewayHealth } from "../../domain/inbox.ts";
import type { InboxRepo, Interrupted } from "../inbox/inboxRepo.ts";

/**
 * What Bolt adds to a listener's `context` for a row from the inbox. Named so
 * they cannot collide with Bolt's own context keys.
 */
export type InboxContext = { inboxRowId?: number; inboxAttempt?: number };

/** The one thing a receiver needs from Bolt's App. */
export type EventProcessor = {
  processEvent: (event: {
    body: Record<string, unknown>;
    ack: (response?: unknown) => Promise<void>;
    retryNum?: number;
    retryReason?: string;
    customProperties?: Record<string, unknown>;
  }) => Promise<unknown>;
};

export type InboxReceiverOptions = {
  readonly inbox: InboxRepo;
  readonly now?: () => number;
  /** How often to look for new rows. Cheap: an indexed read of an empty set. */
  readonly pollMs?: number;
  /** Rows taken per look. */
  readonly batch?: number;
  readonly log?: (line: string) => void;
  /**
   * Tidy the replies a dead process left half-streamed. Runs at start, before
   * any row is handed out, so a retry's answer never lands above the notice.
   */
  readonly onInterrupted?: (row: Interrupted) => Promise<void>;
};

export const INBOX_POLL_MS = 100;
/** Old finished rows are swept roughly hourly. */
const PRUNE_EVERY_MS = 60 * 60_000;

export const createInboxReceiver = (opts: InboxReceiverOptions) => {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((l: string) => console.log(`[inbox] ${l}`));
  let app: EventProcessor | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastPrune = 0;
  const inFlight = new Set<number>();

  const asPayload = (response: unknown): Record<string, unknown> | undefined =>
    typeof response === "object" && response !== null ? (response as Record<string, unknown>) : undefined;

  /** Claim what is waiting and hand each row to Bolt. Returns the dispatches, for tests. */
  const drain = (): Promise<void>[] => {
    if (!app) return [];
    const target = app;
    const rows = opts.inbox.claim(opts.batch ?? 20, now());
    return rows.map((row) => {
      inFlight.add(row.id);
      return target
        .processEvent({
          body: row.body,
          ack: async (response?: unknown) => opts.inbox.recordAck(row.id, asPayload(response), now()),
          retryNum: row.retryNum,
          retryReason: row.retryReason,
          customProperties: { inboxRowId: row.id, inboxAttempt: row.attempts } satisfies InboxContext,
        })
        .then(
          () => opts.inbox.finish(row.id, now()),
          (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log(`row ${row.id} (${row.type}) failed: ${msg}`);
            opts.inbox.fail(row.id, msg, now());
          },
        )
        .finally(() => inFlight.delete(row.id));
    });
  };

  const tick = (): void => {
    try {
      drain();
      if (now() - lastPrune > PRUNE_EVERY_MS) {
        lastPrune = now();
        const gone = opts.inbox.prune(now());
        if (gone > 0) log(`pruned ${gone} finished row(s)`);
      }
    } catch (err) {
      // A locked or busy database is a hiccup, not a reason to stop reading.
      log(`poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    init: (a: EventProcessor) => {
      app = a;
    },
    start: async () => {
      const { redelivered, dropped, interrupted } = opts.inbox.recover(now());
      if (redelivered || dropped) {
        log(`from before the restart: ${redelivered} redelivered, ${dropped} dropped`);
      }
      for (const row of interrupted) {
        await opts.onInterrupted?.(row).catch((err: unknown) =>
          log(`could not tidy row ${row.id}'s reply: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
      const waiting = opts.inbox.counts().pending;
      if (waiting > 0) log(`${waiting} message(s) waited in the inbox while I was away`);
      tick();
      timer = setInterval(tick, opts.pollMs ?? INBOX_POLL_MS);
      return undefined;
    },
    stop: async () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      return undefined;
    },
    /** Remember a reply message a row opened, so a crash can be tidied after. */
    recordStream: (rowId: number, channel: string, ts: string): void => {
      try {
        opts.inbox.addStream(rowId, channel, ts);
      } catch (err) {
        log(`could not record stream ${ts} for row ${rowId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    /** Rows handed to Bolt and not yet finished. */
    inFlight: () => inFlight.size,
    /** Whether the gateway is hearing Slack, for /health and `sys`. */
    health: (): ConnectionHealth => gatewayHealth(opts.inbox.gateway(), now()),
    /** Exposed for tests: one poll, returning the dispatches it started. */
    drain,
  };
};

export type InboxReceiver = ReturnType<typeof createInboxReceiver>;

/** The one Web API call the tidy-up needs; the real WebClient has it. */
export type ApiCaller = { apiCall: (method: string, args: Record<string, unknown>) => Promise<unknown> };

/**
 * Close a dead process's streams and say what happened in their place.
 *
 * Measured against the real API: a stream left open by a process that died
 * can be stopped from a fresh one with `chat.stopStream`, and then rewritten
 * with `chat.update` - but only with a `markdown` block, since a stopped
 * stream refuses a `context`-only rewrite with `block_mismatch`. A stop that
 * fails is usually one Slack already timed out, so the rewrite still runs.
 * A reply that rolled over is several messages: the notice goes on the first,
 * and the rest are deleted.
 */
export const tidyInterrupted = async (
  api: ApiCaller,
  row: Interrupted,
  notice: string,
  log: (line: string) => void = () => undefined,
): Promise<void> => {
  const fail = (what: string, ts: string) => (err: unknown) =>
    log(`${what} ${row.channel}/${ts} failed: ${err instanceof Error ? err.message : String(err)}`);
  for (const [i, ts] of row.streamTs.entries()) {
    await api.apiCall("chat.stopStream", { channel: row.channel, ts }).catch(() => undefined);
    if (i === 0) {
      await api
        .apiCall("chat.update", { channel: row.channel, ts, text: notice, blocks: [{ type: "markdown", text: notice }] })
        .catch(fail("rewrite", ts));
    } else {
      await api.apiCall("chat.delete", { channel: row.channel, ts }).catch(fail("delete", ts));
    }
  }
};
