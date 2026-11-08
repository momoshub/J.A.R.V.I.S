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
import { envelopeThread, unnotified } from "../../domain/drainNotice.ts";
import { footerLine, SIGNATURES, withFooter } from "../../domain/messageFooter.ts";
import type { InboxRepo, InboxRow, Interrupted } from "../inbox/inboxRepo.ts";

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
  /**
   * Told every thread whose message is waiting on a restart, the whole list
   * each time a new one joins it. Optional: an instance that wires nothing
   * simply stays silent, as it did before.
   */
  onDeferred?: (waiting: readonly { channel: string; threadTs?: string }[]) => void | Promise<void>;
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
  /**
   * A row claimed while a restart waits has run past its budget. Cut what it
   * started and tell the thread; return whether anything was cut. Only then
   * is the row marked cut and left running for the next process to pick up.
   * Something that cannot be cut (no turn to stop) is left to finish.
   */
  readonly onOverBudget?: (rowId: number) => boolean;
  /**
   * While a restart waits, rows this answers true for are not claimed: they
   * stay pending for the next process (commands, slash commands, buttons -
   * work that cannot be cut at a budget and picked up again).
   */
  readonly waitsForRestart?: (row: InboxRow) => boolean;
};

export const INBOX_POLL_MS = 100;
/** How far past the batch to look for held-back rows behind chat that is about to be claimed. */
const HELD_LOOKAHEAD = 200;
/** Old finished rows are swept roughly hourly. */
const PRUNE_EVERY_MS = 60 * 60_000;

export const createInboxReceiver = (opts: InboxReceiverOptions) => {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((l: string) => console.log(`[inbox] ${l}`));
  let app: EventProcessor | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastPrune = 0;
  // A pending restart stops taking rows; the gateway keeps queueing them.
  let paused = false;
  // Set while a restart waits: rows claimed from then on run on this budget.
  let budgetMs: number | undefined;
  /** Threads already told that a restart is holding their message. */
  const told = new Set<string>();
  const waiting: { channel: string; threadTs?: string }[] = [];
  /**
   * Rows handed to Bolt and not yet finished. `budgeted` rows were claimed
   * while a restart waits; `checked` once their budget ran out and they were
   * looked at; `held` once cut for the restart - those are left running.
   */
  const inFlight = new Map<number, { claimedAt: number; budgeted: boolean; checked: boolean; held: boolean }>();

  const asPayload = (response: unknown): Record<string, unknown> | undefined =>
    typeof response === "object" && response !== null ? (response as Record<string, unknown>) : undefined;

  /** Claim what is waiting and hand each row to Bolt. Returns the dispatches, for tests. */
  const drain = (): Promise<void>[] => {
    if (!app || paused) return [];
    const target = app;
    const defer = budgetMs !== undefined ? opts.waitsForRestart : undefined;
    const rows = opts.inbox.claim(opts.batch ?? 20, now(), defer ? (row) => !defer(row) : undefined);
    const claimedAt = now();
    return rows.map((row) => {
      const flight = { claimedAt, budgeted: budgetMs !== undefined, checked: false, held: false };
      inFlight.set(row.id, flight);
      return target
        .processEvent({
          body: row.body,
          ack: async (response?: unknown) => opts.inbox.recordAck(row.id, asPayload(response), now()),
          retryNum: row.retryNum,
          retryReason: row.retryReason,
          customProperties: { inboxRowId: row.id, inboxAttempt: row.attempts } satisfies InboxContext,
        })
        .then(
          // A row cut for the restart stays running: the next process picks it up.
          () => {
            if (!flight.held) opts.inbox.finish(row.id, now());
          },
          (err: unknown) => {
            if (flight.held) return;
            const msg = err instanceof Error ? err.message : String(err);
            log(`row ${row.id} (${row.type}) failed: ${msg}`);
            opts.inbox.fail(row.id, msg, now());
          },
        )
        .finally(() => inFlight.delete(row.id));
    });
  };

  /**
   * While paused, look at what is waiting and list each thread once. While a
   * restart waits but the intake is still open, list only the rows held back
   * for the next process (`waitsForRestart`): chat is still being answered.
   *
   * Nothing is claimed: the rows have to stay pending for the next process.
   * This exists because silence and death look identical from a thread - a
   * question, then "??", then "??" into nothing is how a planned restart gets
   * reported as a bug.
   */
  const reassure = (only?: (row: InboxRow) => boolean): void => {
    if (!opts.onDeferred) return;
    const batch = opts.batch ?? 20;
    const rows = only ? opts.inbox.peek(batch + HELD_LOOKAHEAD, now()).filter(only) : opts.inbox.peek(batch, now());
    const targets = rows
      .map((row) => envelopeThread(row.body))
      .filter((t): t is { channel: string; threadTs?: string } => !!t);
    const fresh = unnotified(targets, told);
    if (fresh.length === 0) return;
    for (const t of fresh) {
      told.add(t.key);
      waiting.push(t.threadTs ? { channel: t.channel, threadTs: t.threadTs } : { channel: t.channel });
    }
    try {
      void opts.onDeferred([...waiting]);
    } catch {
      // a courtesy that fails is still only a courtesy
    }
  };

  /**
   * Cut the rows that started while a restart waits and ran past the budget.
   * Each is looked at once: one that cannot be cut is left to finish, and the
   * restart's own cap still bounds it.
   */
  const enforceBudget = (): void => {
    if (budgetMs === undefined || !opts.onOverBudget) return;
    for (const [id, f] of inFlight) {
      if (!f.budgeted || f.checked || now() - f.claimedAt < budgetMs) continue;
      f.checked = true;
      if (!opts.onOverBudget(id)) continue;
      f.held = true;
      opts.inbox.markCutRow(id, now());
      log(`row ${id} ran past its ${Math.round(budgetMs / 1000)}s budget while a restart waits; cut, the next process picks it up`);
    }
  };

  const tick = (): void => {
    try {
      enforceBudget();
      if (paused) reassure();
      drain();
      // After the claim, so the only rows left to list are the held-back ones.
      if (!paused && budgetMs !== undefined && opts.waitsForRestart) reassure(opts.waitsForRestart);
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
      const { redelivered, deferred, dropped, interrupted } = opts.inbox.recover(now());
      if (redelivered || deferred || dropped) {
        log(`from before the restart: ${redelivered} redelivered, ${deferred} retrying in a few minutes, ${dropped} dropped`);
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
    /** One poll, for tests: the loop otherwise runs on its own timer. */
    tickNow: (): void => tick(),
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
    /**
     * Take no more rows. For a restart, once the turns from before it have
     * finished: the bot finishes what it has, and everything that arrives
     * meanwhile waits in the inbox for the next process.
     */
    pause: (): void => {
      // The list carries on: commands held back while the budget was on were
      // already told, and the notice keeps naming them.
      paused = true;
    },
    /**
     * A restart is waiting: keep taking rows, but each one claimed from now on
     * runs on `ms` and is cut past it (`onOverBudget`).
     */
    budget: (ms: number): void => {
      budgetMs = ms;
    },
    /** Mark the rows still running as cut by a planned restart. */
    markCut: (): number => opts.inbox.markCut(now()),
    /** Rows handed to Bolt and not yet finished. */
    inFlight: () => inFlight.size,
    /** Rows in flight that were claimed before a restart was asked for. */
    unbudgetedInFlight: () => [...inFlight.values()].filter((f) => !f.budgeted).length,
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
  clock: () => number = Date.now,
): Promise<void> => {
  const fail = (what: string, ts: string) => (err: unknown) =>
    log(`${what} ${row.channel}/${ts} failed: ${err instanceof Error ? err.message : String(err)}`);
  for (const [i, ts] of row.streamTs.entries()) {
    await api.apiCall("chat.stopStream", { channel: row.channel, ts }).catch(() => undefined);
    if (i === 0) {
      await api
        .apiCall("chat.update", {
          channel: row.channel,
          ts,
          text: notice,
          // The markdown block is what a stopped stream accepts; the footer
          // rides under it, signed and stamped like every other message.
          blocks: withFooter([{ type: "markdown", text: notice }], footerLine(SIGNATURES.jarvis, clock())),
        })
        .catch(fail("rewrite", ts));
    } else {
      await api.apiCall("chat.delete", { channel: row.channel, ts }).catch(fail("delete", ts));
    }
  }
};
