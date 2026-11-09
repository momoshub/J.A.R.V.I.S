/**
 * How each turn ended, so "what is going on" has an answer.
 *
 * One row per chat or workflow turn: who asked, in which thread, what they
 * asked, and whether it worked. A failed turn keeps its request text so it can
 * simply be run again.
 */
import type { DbClient } from "./client.ts";

/** `ok` finished, `failed` threw, `stopped` was cancelled before it finished. */
export type TurnOutcome = "ok" | "failed" | "stopped";

export type TurnEntry = {
  readonly id: number;
  readonly runId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly slackUserId: string;
  readonly kind: string;
  readonly request: string;
  readonly outcome: TurnOutcome;
  readonly error: string;
  readonly startedAt: number;
  readonly endedAt: number;
};

export type NewTurn = Omit<TurnEntry, "id">;

type Row = {
  id: number;
  run_id: string;
  channel_id: string;
  thread_ts: string;
  slack_user_id: string;
  kind: string;
  request: string;
  outcome: string;
  error: string;
  started_at: number;
  ended_at: number;
};

const asOutcome = (v: string): TurnOutcome =>
  v === "failed" || v === "stopped" ? v : "ok";

const toEntry = (r: Row): TurnEntry => ({
  id: r.id,
  runId: r.run_id,
  channelId: r.channel_id,
  threadTs: r.thread_ts,
  slackUserId: r.slack_user_id,
  kind: r.kind,
  request: r.request,
  outcome: asOutcome(r.outcome),
  error: r.error,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

export type TurnLogRepo = {
  add: (turn: NewTurn) => void;
  /** Everything that ended since `since`, newest first. */
  since: (since: number, limit?: number) => TurnEntry[];
  /** The newest turn of one thread, whatever its outcome. */
  latestInThread: (channelId: string, threadTs: string) => TurnEntry | undefined;
  /**
   * Threads whose NEWEST turn failed - the ones still broken, rather than every
   * thread that has ever had a bad turn. A thread that failed and then worked
   * needs nobody's attention, and neither does one a person deliberately
   * stopped (or a restart cut and redelivered): `stopped` is not unfinished work.
   */
  stuckThreads: (since: number, limit?: number) => TurnEntry[];
  count: () => number;
};

export const createTurnLogRepo = (db: DbClient): TurnLogRepo => {
  const insertStmt = db.query(
    `INSERT INTO turn_log
       (run_id, channel_id, thread_ts, slack_user_id, kind, request, outcome, error, started_at, ended_at)
     VALUES ($runId, $channelId, $threadTs, $slackUserId, $kind, $request, $outcome, $error, $startedAt, $endedAt)`,
  );
  const sinceStmt = db.query<Row, [number, number]>(
    "SELECT * FROM turn_log WHERE ended_at >= ? ORDER BY ended_at DESC LIMIT ?",
  );
  const latestStmt = db.query<Row, [string, string]>(
    "SELECT * FROM turn_log WHERE channel_id = ? AND thread_ts = ? ORDER BY id DESC LIMIT 1",
  );
  // The newest row per thread, then only the ones that failed. A stopped turn is a
  // decision (or a restart that redelivers), so it is counted in `since`, not here.
  const stuckStmt = db.query<Row, [number, number]>(
    `SELECT * FROM turn_log t
      WHERE t.ended_at >= ?
        AND t.id = (SELECT MAX(t2.id) FROM turn_log t2
                     WHERE t2.channel_id = t.channel_id AND t2.thread_ts = t.thread_ts)
        AND t.outcome = 'failed'
      ORDER BY t.ended_at DESC LIMIT ?`,
  );
  const countStmt = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM turn_log");

  return {
    add: (turn) => {
      insertStmt.run({
        $runId: turn.runId,
        $channelId: turn.channelId,
        $threadTs: turn.threadTs,
        $slackUserId: turn.slackUserId,
        $kind: turn.kind,
        // Enough to recognise it and to run it again; not a transcript.
        $request: turn.request.slice(0, 2000),
        $outcome: turn.outcome,
        $error: turn.error.slice(0, 500),
        $startedAt: turn.startedAt,
        $endedAt: turn.endedAt,
      });
    },
    since: (since, limit = 50) => sinceStmt.all(since, Math.max(1, limit)).map(toEntry),
    latestInThread: (channelId, threadTs) => {
      const r = latestStmt.get(channelId, threadTs);
      return r ? toEntry(r) : undefined;
    },
    stuckThreads: (since, limit = 20) => stuckStmt.all(since, Math.max(1, limit)).map(toEntry),
    count: () => countStmt.get()?.n ?? 0,
  };
};
