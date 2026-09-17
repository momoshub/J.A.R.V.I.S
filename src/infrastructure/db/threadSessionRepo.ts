/**
 * Thread session repository - the CLI session bound to a Slack thread.
 *
 * Keeping the id in the database rather than in memory means a thread survives
 * a restart: the next message resumes the same session instead of starting the
 * conversation over. One row per (thread, tier); see `domain/threadSession.ts`
 * for why the tier is part of the key.
 */
import type { DbClient } from "./client.ts";
import type { SessionTier } from "../../domain/threadSession.ts";

export type ThreadSession = {
  sessionId: string;
  /** Slack ts of the newest turn this session has already been shown. */
  lastTs: string;
  /** Turns taken on this session, for the dashboard and for sanity checks. */
  turns: number;
  createdAt: number;
  usedAt: number;
};

export type ThreadSessionRepo = {
  /** The session driving this thread at this tier, if there is one. */
  find: (channelId: string, threadTs: string, tier: SessionTier) => ThreadSession | undefined;
  /** Bind a new session to the thread, replacing any that was there. */
  claim: (
    channelId: string,
    threadTs: string,
    tier: SessionTier,
    sessionId: string,
    lastTs: string,
    now: number,
  ) => void;
  /** Record a turn taken on the session, and how far it has now been shown. */
  touch: (channelId: string, threadTs: string, tier: SessionTier, lastTs: string, now: number) => void;
  /** Forget it - the CLI no longer has it, or someone asked for a fresh start. */
  drop: (channelId: string, threadTs: string, tier?: SessionTier) => void;
};

type Row = { session_id: string; last_ts: string; turns: number; created_at: number; used_at: number };

export const createThreadSessionRepo = (db: DbClient): ThreadSessionRepo => {
  const findStmt = db.query<Row, [string, string, string]>(
    "SELECT session_id, last_ts, turns, created_at, used_at FROM thread_sessions WHERE channel_id = ? AND thread_ts = ? AND tier = ?",
  );
  const claimStmt = db.query(
    `INSERT INTO thread_sessions (channel_id, thread_ts, tier, session_id, last_ts, turns, created_at, used_at)
     VALUES ($channel, $thread, $tier, $session, $lastTs, 1, $now, $now)
     ON CONFLICT(channel_id, thread_ts, tier)
     DO UPDATE SET session_id = excluded.session_id, last_ts = excluded.last_ts, turns = 1,
                   created_at = excluded.created_at, used_at = excluded.used_at`,
  );
  const touchStmt = db.query(
    "UPDATE thread_sessions SET turns = turns + 1, last_ts = $lastTs, used_at = $now WHERE channel_id = $channel AND thread_ts = $thread AND tier = $tier",
  );
  const dropStmt = db.query(
    "DELETE FROM thread_sessions WHERE channel_id = $channel AND thread_ts = $thread AND tier = $tier",
  );
  const dropAllStmt = db.query(
    "DELETE FROM thread_sessions WHERE channel_id = $channel AND thread_ts = $thread",
  );

  return {
    find: (channelId, threadTs, tier) => {
      const row = findStmt.get(channelId, threadTs, tier);
      return row
        ? { sessionId: row.session_id, lastTs: row.last_ts, turns: row.turns, createdAt: row.created_at, usedAt: row.used_at }
        : undefined;
    },
    claim: (channelId, threadTs, tier, sessionId, lastTs, now) => {
      claimStmt.run({ $channel: channelId, $thread: threadTs, $tier: tier, $session: sessionId, $lastTs: lastTs, $now: now });
    },
    touch: (channelId, threadTs, tier, lastTs, now) => {
      touchStmt.run({ $channel: channelId, $thread: threadTs, $tier: tier, $lastTs: lastTs, $now: now });
    },
    drop: (channelId, threadTs, tier) => {
      if (tier) dropStmt.run({ $channel: channelId, $thread: threadTs, $tier: tier });
      else dropAllStmt.run({ $channel: channelId, $thread: threadTs });
    },
  };
};
