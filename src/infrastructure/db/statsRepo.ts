/**
 * Activity aggregates for the dashboard's overview charts.
 *
 * Read-only sums over tables other repos own (messages, turn_log, llm_usage,
 * command_log, thread_sessions), computed in SQL on every request: the tables
 * are indexed on time and small, and a counter kept on the side would drift.
 *
 * Days are bucketed by `day = floor((ms + offsetMs) / 86_400_000)`, so the
 * caller decides the timezone; `domain/dashboardStats.ts` turns a day number
 * back into a date and fills the days with nothing in them.
 */
import type { DbClient } from "./client.ts";

export type MessageDay = { readonly day: number; readonly user: number; readonly assistant: number };
export type TurnDay = { readonly day: number; readonly ok: number; readonly failed: number };
export type SpendDay = { readonly day: number; readonly runs: number; readonly costUsd: number };
export type CommandCount = { readonly key: string; readonly runs: number; readonly failed: number };
export type UserActivity = { readonly key: string; readonly turns: number; readonly commands: number };

export type StatsRepo = {
  messagesPerDay: (since: number, offsetMs: number) => MessageDay[];
  turnsPerDay: (since: number, offsetMs: number) => TurnDay[];
  spendPerDay: (since: number, offsetMs: number) => SpendDay[];
  /** Commands run since `since`, most-run first. */
  topCommands: (since: number, limit: number) => CommandCount[];
  /** People by chat/workflow turns plus commands since `since`, busiest first. */
  topUsers: (since: number, limit: number) => UserActivity[];
  /** Threads whose session was used since `since`. */
  activeThreads: (since: number) => number;
};

const DAY = "CAST((%col% + ?2) / 86400000 AS INTEGER)";
const day = (col: string) => DAY.replace("%col%", col);

export const createStatsRepo = (db: DbClient): StatsRepo => {
  const messagesStmt = db.query<MessageDay, [number, number]>(
    `SELECT ${day("created_at")} AS day,
       SUM(role = 'user') AS user, SUM(role = 'assistant') AS assistant
     FROM messages WHERE created_at >= ?1 GROUP BY day ORDER BY day`,
  );
  const turnsStmt = db.query<TurnDay, [number, number]>(
    `SELECT ${day("ended_at")} AS day,
       SUM(outcome = 'ok') AS ok, SUM(outcome <> 'ok') AS failed
     FROM turn_log WHERE ended_at >= ?1 GROUP BY day ORDER BY day`,
  );
  const spendStmt = db.query<SpendDay, [number, number]>(
    `SELECT ${day("created_at")} AS day, COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS costUsd
     FROM llm_usage WHERE created_at >= ?1 GROUP BY day ORDER BY day`,
  );
  const commandsStmt = db.query<CommandCount, [number, number]>(
    `SELECT command AS key, COUNT(*) AS runs, SUM(ok = 0) AS failed
     FROM command_log WHERE created_at >= ?1 GROUP BY command ORDER BY runs DESC, key LIMIT ?2`,
  );
  const usersStmt = db.query<UserActivity, [number, number]>(
    `SELECT key, SUM(turns) AS turns, SUM(commands) AS commands FROM (
       SELECT slack_user_id AS key, COUNT(*) AS turns, 0 AS commands
         FROM turn_log WHERE ended_at >= ?1 AND slack_user_id <> '' GROUP BY slack_user_id
       UNION ALL
       SELECT slack_user_id AS key, 0 AS turns, COUNT(*) AS commands
         FROM command_log WHERE created_at >= ?1 AND slack_user_id <> '' GROUP BY slack_user_id
     ) GROUP BY key ORDER BY SUM(turns) + SUM(commands) DESC, key LIMIT ?2`,
  );
  const threadsStmt = db.query<{ n: number }, [number]>(
    `SELECT COUNT(*) AS n FROM (
       SELECT DISTINCT channel_id, thread_ts FROM thread_sessions WHERE used_at >= ?1
     )`,
  );

  return {
    messagesPerDay: (since, offsetMs) => messagesStmt.all(since, offsetMs),
    turnsPerDay: (since, offsetMs) => turnsStmt.all(since, offsetMs),
    spendPerDay: (since, offsetMs) => spendStmt.all(since, offsetMs),
    topCommands: (since, limit) => commandsStmt.all(since, Math.max(1, limit)),
    topUsers: (since, limit) => usersStmt.all(since, Math.max(1, limit)),
    activeThreads: (since) => threadsStmt.get(since)?.n ?? 0,
  };
};
