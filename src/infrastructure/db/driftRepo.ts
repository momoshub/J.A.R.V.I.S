/**
 * Voice drift the inner child found and steered, and what came of each nudge.
 */
import type { DbClient } from "./client.ts";
import type { DriftOutcome } from "../../domain/voiceDrift.ts";

export type DriftState = "steering" | DriftOutcome;

export type DriftEvent = {
  readonly id: number;
  readonly channelId: string;
  readonly threadTs: string;
  readonly replyKey: string;
  readonly replyTs: string;
  readonly rules: string;
  readonly excerpt: string;
  readonly nudge: string;
  readonly logChannel: string;
  readonly logTs: string;
  readonly steeredAt: number;
  readonly followUpText: string;
  readonly followUpTs: string;
  readonly outcome: DriftState;
  readonly createdAt: number;
};

export type NewDriftEvent = {
  readonly channelId: string;
  readonly threadTs: string;
  readonly replyKey: string;
  readonly replyTs: string;
  readonly rules: string;
  readonly excerpt: string;
  readonly nudge: string;
};

type Row = {
  id: number;
  channel_id: string;
  thread_ts: string;
  reply_key: string;
  reply_ts: string;
  rules: string;
  excerpt: string;
  nudge: string;
  log_channel: string;
  log_ts: string;
  steered_at: number;
  follow_up_text: string;
  follow_up_ts: string;
  outcome: string;
  created_at: number;
};

const asState = (v: string): DriftState =>
  v === "corrected" || v === "no_change" || v === "no_reply" || v === "failed" ? v : "steering";

const toEvent = (r: Row): DriftEvent => ({
  id: r.id,
  channelId: r.channel_id,
  threadTs: r.thread_ts,
  replyKey: r.reply_key,
  replyTs: r.reply_ts,
  rules: r.rules,
  excerpt: r.excerpt,
  nudge: r.nudge,
  logChannel: r.log_channel,
  logTs: r.log_ts,
  steeredAt: r.steered_at,
  followUpText: r.follow_up_text,
  followUpTs: r.follow_up_ts,
  outcome: asState(r.outcome),
  createdAt: r.created_at,
});

export type DriftRepo = {
  /** Record a drifted reply as steering. undefined when that reply is already on file. */
  record: (e: NewDriftEvent, now: number) => DriftEvent | undefined;
  /** Where its #jarvis_logs message landed, so the follow-up goes in that thread. */
  setLog: (id: number, channel: string, ts: string) => void;
  /** What the session answered, once its turn is over. */
  settle: (id: number, outcome: DriftOutcome, followUpText: string, followUpTs: string, now: number) => void;
  /** Rows still waiting on a steered turn. */
  steering: () => DriftEvent[];
  /** How many nudges were sent since `since`, for the daily cap. */
  steeredSince: (since: number) => number;
  get: (id: number) => DriftEvent | undefined;
};

export const createDriftRepo = (db: DbClient): DriftRepo => {
  const insert = db.query<Row, [string, string, string, string, string, string, string, number, number, number]>(
    `INSERT OR IGNORE INTO drift_events
       (channel_id, thread_ts, reply_key, reply_ts, rules, excerpt, nudge, steered_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  );
  const logStmt = db.query("UPDATE drift_events SET log_channel = ?, log_ts = ? WHERE id = ?");
  const settleStmt = db.query(
    "UPDATE drift_events SET outcome = ?, follow_up_text = ?, follow_up_ts = ?, updated_at = ? WHERE id = ?",
  );
  const steeringStmt = db.query<Row, []>("SELECT * FROM drift_events WHERE outcome = 'steering' ORDER BY id");
  const sinceStmt = db.query<{ n: number }, [number]>(
    "SELECT COUNT(*) AS n FROM drift_events WHERE steered_at >= ?",
  );
  const getStmt = db.query<Row, [number]>("SELECT * FROM drift_events WHERE id = ?");

  return {
    record: (e, now) => {
      const r = insert.get(e.channelId, e.threadTs, e.replyKey, e.replyTs, e.rules, e.excerpt, e.nudge, now, now, now);
      return r ? toEvent(r) : undefined;
    },
    setLog: (id, channel, ts) => void logStmt.run(channel, ts, id),
    settle: (id, outcome, text, ts, now) => void settleStmt.run(outcome, text, ts, now, id),
    steering: () => steeringStmt.all().map(toEvent),
    steeredSince: (since) => sinceStmt.get(since)?.n ?? 0,
    get: (id) => {
      const r = getStmt.get(id);
      return r ? toEvent(r) : undefined;
    },
  };
};
