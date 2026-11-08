/**
 * The durable queue between the Slack gateway and the bot.
 *
 * Its own SQLite file, not the main database: two processes write it, it is
 * pure transient traffic, and the main database is committed to git while
 * this must never be. WAL lets the gateway write while the bot reads, and the
 * schema is created idempotently by whichever process opens it first - there
 * is no migration ladder, so keep this table boring and additive.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  dedupeKeyOf,
  KEEP_FINISHED_MS,
  MAX_ATTEMPTS,
  PENDING_MAX_AGE_MS,
  recoveryFor,
  type EnvelopeType,
  RETRY_DELAY_MS,
  type InboxState,
  type Recovery,
} from "../../domain/inbox.ts";
import type { ConnectionState } from "../../domain/connectionHealth.ts";

export type InboxRow = {
  readonly id: number;
  readonly type: EnvelopeType;
  readonly body: Record<string, unknown>;
  readonly retryNum?: number;
  readonly retryReason?: string;
  readonly receivedAt: number;
  readonly state: InboxState;
  readonly attempts: number;
};

export type NewEnvelope = {
  readonly envelopeId: string;
  readonly type: EnvelopeType;
  readonly body: unknown;
  readonly retryNum?: number;
  readonly retryReason?: string;
};

/** What the gateway last said about its socket. */
export type GatewayState = { state: ConnectionState; since: number; beatAt: number; pid: number };

/**
 * A row a previous process was running when it died, with the replies it had
 * started streaming. Those messages are left half-written and still marked
 * streaming in Slack, and nothing else knows they exist.
 */
export type Interrupted = {
  readonly id: number;
  readonly channel: string;
  readonly streamTs: readonly string[];
  readonly outcome: Recovery;
  /** Dropped because it was cut off on every attempt, not because it was old. */
  readonly retried: boolean;
};

/** An ack the bot gave: absent while it has not answered yet. */
export type AckReply = { payload?: Record<string, unknown> };

type Row = {
  id: number;
  type: string;
  body: string;
  retry_num: number | null;
  retry_reason: string | null;
  received_at: number;
  state: string;
  attempts: number;
};

const toRow = (r: Row): InboxRow => ({
  id: r.id,
  type: r.type as EnvelopeType,
  body: JSON.parse(r.body) as Record<string, unknown>,
  retryNum: r.retry_num ?? undefined,
  retryReason: r.retry_reason ?? undefined,
  receivedAt: r.received_at,
  state: r.state as InboxState,
  attempts: r.attempts,
});

export type InboxRepo = {
  /** Store an envelope. Returns its id, or undefined when it is a duplicate. */
  enqueue: (e: NewEnvelope, at: number) => number | undefined;
  /** Mark up to `limit` pending rows running, oldest first, and return them. */
  /**
   * Take up to `limit` pending rows, oldest first. With `take`, rows it turns
   * down are skipped and stay pending (a restart waiting: commands wait for
   * the next process while chat still runs).
   */
  claim: (limit: number, at: number, take?: (row: InboxRow) => boolean) => InboxRow[];
  /**
   * What is waiting, WITHOUT claiming it. Used while a restart holds the
   * intake: the rows must stay pending for the next process, but whoever is
   * waiting on them can still be told that somebody is coming.
   */
  peek: (limit: number, at: number) => InboxRow[];
  /** The bot acked a row; the gateway passes `payload` on to Slack. */
  recordAck: (id: number, payload: Record<string, unknown> | undefined, at: number) => void;
  /** The ack the bot gave, once it has. */
  ackFor: (id: number) => AckReply | undefined;
  finish: (id: number, at: number) => void;
  fail: (id: number, error: string, at: number) => void;
  /** Remember a reply message this row opened, until the row finishes. */
  addStream: (id: number, channel: string, ts: string) => void;
  /**
   * Settle what a previous bot process left behind: rows it was running are
   * redelivered or dropped, and pending rows too old to matter are dropped.
   */
  recover: (now: number) => { redelivered: number; deferred: number; dropped: number; interrupted: Interrupted[] };
  /**
   * Mark every running row as cut by a planned restart, just before the
   * process exits under it, so recovery picks it up again at once.
   */
  markCut: (at: number) => number;
  /**
   * Mark ONE running row as cut for the restart: a turn that ran past its
   * budget while a restart waits. It stays running, so it is not finished
   * here, and the next process redelivers it like any other cut row.
   */
  markCutRow: (id: number, at: number) => boolean;
  /** Delete finished rows past their keep time. */
  prune: (now: number) => number;
  counts: () => Record<InboxState, number>;
  heartbeat: (s: GatewayState) => void;
  gateway: () => GatewayState | undefined;
  close: () => void;
};

export const openInbox = (path: string): InboxRepo => {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      body TEXT NOT NULL,
      retry_num INTEGER,
      retry_reason TEXT,
      received_at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at INTEGER,
      finished_at INTEGER,
      acked_at INTEGER,
      ack_body TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS inbox_state_id ON inbox (state, id);
    CREATE TABLE IF NOT EXISTS gateway_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL,
      since INTEGER NOT NULL,
      beat_at INTEGER NOT NULL,
      pid INTEGER NOT NULL
    );
  `);

  // Added after the table first shipped. CREATE TABLE IF NOT EXISTS does not
  // add a column to a table that is already there, so add what is missing.
  const columns = new Set((db.prepare(`PRAGMA table_info(inbox)`).all() as { name: string }[]).map((c) => c.name));
  if (!columns.has("channel")) db.exec(`ALTER TABLE inbox ADD COLUMN channel TEXT`);
  if (!columns.has("stream_ts")) db.exec(`ALTER TABLE inbox ADD COLUMN stream_ts TEXT`);
  // A deferred retry is pending but not claimable until then.
  if (!columns.has("not_before")) db.exec(`ALTER TABLE inbox ADD COLUMN not_before INTEGER`);
  // Set on running rows when a planned restart cuts them.
  if (!columns.has("cut_at")) db.exec(`ALTER TABLE inbox ADD COLUMN cut_at INTEGER`);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO inbox (dedupe_key, type, body, retry_num, retry_reason, received_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const pending = db.prepare(
    `SELECT * FROM inbox WHERE state = 'pending' AND (not_before IS NULL OR not_before <= ?) ORDER BY id LIMIT ?`,
  );
  const markRunning = db.prepare(
    `UPDATE inbox SET state = 'running', attempts = attempts + 1, claimed_at = ? WHERE id = ? AND state = 'pending'`,
  );
  /** How far past `limit` a filtered claim looks, so skipped rows cannot starve the rest. */
  const SKIP_LOOKAHEAD = 200;
  const claimTx = db.transaction((limit: number, at: number, take?: (row: InboxRow) => boolean): InboxRow[] => {
    const seen = pending.all(at, take ? limit + SKIP_LOOKAHEAD : limit) as Row[];
    const rows = take ? seen.filter((r) => take(toRow(r))).slice(0, limit) : seen;
    for (const r of rows) markRunning.run(at, r.id);
    return rows.map((r) => ({ ...toRow(r), state: "running" as const, attempts: r.attempts + 1 }));
  });
  const settle = db.prepare(`UPDATE inbox SET state = ?, finished_at = ?, error = ? WHERE id = ?`);

  return {
    enqueue: (e, at) => {
      const res = insert.run(
        dedupeKeyOf(e.envelopeId, e.body),
        e.type,
        JSON.stringify(e.body ?? {}),
        e.retryNum ?? null,
        e.retryReason ?? null,
        at,
      );
      return res.changes > 0 ? Number(res.lastInsertRowid) : undefined;
    },
    claim: (limit, at, take) => claimTx(limit, at, take),
    // Looks, never claims: the rows must stay pending for the next process.
    peek: (limit, at) => (pending.all(at, limit) as Row[]).map(toRow),
    recordAck: (id, payload, at) => {
      db.prepare(`UPDATE inbox SET acked_at = ?, ack_body = ? WHERE id = ? AND acked_at IS NULL`).run(
        at,
        payload ? JSON.stringify(payload) : null,
        id,
      );
    },
    ackFor: (id) => {
      const r = db.prepare(`SELECT acked_at, ack_body FROM inbox WHERE id = ?`).get(id) as
        | { acked_at: number | null; ack_body: string | null }
        | null;
      if (!r || r.acked_at === null) return undefined;
      return r.ack_body ? { payload: JSON.parse(r.ack_body) as Record<string, unknown> } : {};
    },
    finish: (id, at) => void settle.run("done", at, null, id),
    addStream: (id, channel, ts) => {
      db.prepare(
        `UPDATE inbox SET channel = ?, stream_ts = CASE WHEN stream_ts IS NULL OR stream_ts = '' THEN ? ELSE stream_ts || ',' || ? END WHERE id = ?`,
      ).run(channel, ts, ts, id);
    },
    fail: (id, error, at) => void settle.run("failed", at, error.slice(0, 2000), id),
    recover: (now) => {
      let redelivered = 0;
      let deferred = 0;
      let dropped = 0;
      const interrupted: Interrupted[] = [];
      const running = db.prepare(`SELECT * FROM inbox WHERE state = 'running'`).all() as (Row & {
        channel: string | null;
        stream_ts: string | null;
        claimed_at: number | null;
        cut_at: number | null;
      })[];
      for (const r of running) {
        const outcome = recoveryFor(
          { receivedAt: r.received_at, claimedAt: r.claimed_at ?? undefined, attempts: r.attempts, cutAt: r.cut_at ?? undefined },
          now,
        );
        if (outcome !== "drop") {
          // The streams are reported once, here, and forgotten: the retry
          // opens its own, and must not have these tidied a second time.
          db.prepare(`UPDATE inbox SET state = 'pending', stream_ts = NULL, cut_at = NULL, not_before = ? WHERE id = ?`).run(
            outcome === "defer" ? now + RETRY_DELAY_MS : null,
            r.id,
          );
          if (outcome === "defer") deferred += 1;
          else redelivered += 1;
        } else {
          settle.run("dropped", now, "interrupted by a restart, too old or retried too often", r.id);
          dropped += 1;
        }
        const streamTs = (r.stream_ts ?? "").split(",").filter(Boolean);
        if (r.channel && streamTs.length) {
          interrupted.push({ id: r.id, channel: r.channel, streamTs, outcome, retried: r.attempts >= MAX_ATTEMPTS });
        }
      }
      const stale = db
        .prepare(`UPDATE inbox SET state = 'dropped', finished_at = ?, error = 'waited too long' WHERE state = 'pending' AND received_at < ?`)
        .run(now, now - PENDING_MAX_AGE_MS);
      dropped += stale.changes;
      return { redelivered, deferred, dropped, interrupted };
    },
    markCut: (at) => db.prepare(`UPDATE inbox SET cut_at = ? WHERE state = 'running'`).run(at).changes,
    markCutRow: (id, at) =>
      db.prepare(`UPDATE inbox SET cut_at = ? WHERE id = ? AND state = 'running'`).run(at, id).changes > 0,
    prune: (now) =>
      db
        .prepare(`DELETE FROM inbox WHERE state IN ('done', 'failed', 'dropped') AND finished_at < ?`)
        .run(now - KEEP_FINISHED_MS).changes,
    counts: () => {
      const out: Record<InboxState, number> = { pending: 0, running: 0, done: 0, failed: 0, dropped: 0 };
      for (const r of db.prepare(`SELECT state, COUNT(*) AS n FROM inbox GROUP BY state`).all() as {
        state: InboxState;
        n: number;
      }[]) {
        out[r.state] = r.n;
      }
      return out;
    },
    heartbeat: (s) => {
      db.prepare(
        `INSERT INTO gateway_state (id, state, since, beat_at, pid) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, since = excluded.since, beat_at = excluded.beat_at, pid = excluded.pid`,
      ).run(s.state, s.since, s.beatAt, s.pid);
    },
    gateway: () => {
      const r = db.prepare(`SELECT state, since, beat_at, pid FROM gateway_state WHERE id = 1`).get() as
        | { state: ConnectionState; since: number; beat_at: number; pid: number }
        | null;
      return r ? { state: r.state, since: r.since, beatAt: r.beat_at, pid: r.pid } : undefined;
    },
    close: () => db.close(),
  };
};
