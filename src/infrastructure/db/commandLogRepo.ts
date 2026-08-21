/**
 * Command log repository - an audit trail of every command run, for the
 * dashboard's history page.
 */
import type { DbClient } from "./client.ts";

export type CommandLogEntry = {
  readonly id: number;
  readonly slackUserId: string;
  readonly command: string;
  readonly args: string;
  readonly channelId: string;
  readonly ok: boolean;
  readonly result: string;
  readonly createdAt: number;
};

export type NewCommandLog = Omit<CommandLogEntry, "id" | "createdAt">;

type Row = {
  id: number;
  slack_user_id: string;
  command: string;
  args: string;
  channel_id: string;
  ok: number;
  result: string;
  created_at: number;
};

const toEntry = (r: Row): CommandLogEntry => ({
  id: r.id,
  slackUserId: r.slack_user_id,
  command: r.command,
  args: r.args,
  channelId: r.channel_id,
  ok: r.ok === 1,
  result: r.result,
  createdAt: r.created_at,
});

export type CommandLogRepo = {
  add: (entry: NewCommandLog, createdAt: number) => void;
  recent: (limit: number) => CommandLogEntry[];
  clear: () => number;
  count: () => number;
  /**
   * How many commands this person has run since `since`, ignoring the names in
   * `excluding`. Backs the per-role rate limit, so it counts what was actually
   * attempted - a refusal still consumed a turn of someone's attention.
   */
  countSince: (slackUserId: string, since: number, excluding?: readonly string[]) => number;
};

export const createCommandLogRepo = (db: DbClient): CommandLogRepo => {
  const insertStmt = db.query(
    `INSERT INTO command_log (slack_user_id, command, args, channel_id, ok, result, created_at)
     VALUES ($slackUserId, $command, $args, $channelId, $ok, $result, $createdAt)`,
  );
  const recentStmt = db.query<Row, [number]>(
    "SELECT * FROM command_log ORDER BY id DESC LIMIT ?",
  );
  const clearStmt = db.query("DELETE FROM command_log");
  const countStmt = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM command_log");

  const countSinceStmt = (excluded: number) =>
    db.query<{ n: number }, [string, number, ...string[]]>(
      `SELECT COUNT(*) AS n FROM command_log
       WHERE slack_user_id = ? AND created_at >= ?
       ${excluded > 0 ? `AND command NOT IN (${Array(excluded).fill("?").join(",")})` : ""}`,
    );

  return {
    countSince: (slackUserId, since, excluding = []) =>
      countSinceStmt(excluding.length).get(slackUserId, since, ...excluding)?.n ?? 0,
    add: (entry, createdAt) => {
      insertStmt.run({
        $slackUserId: entry.slackUserId,
        $command: entry.command,
        $args: entry.args,
        $channelId: entry.channelId,
        $ok: entry.ok ? 1 : 0,
        $result: entry.result.slice(0, 300),
        $createdAt: createdAt,
      });
    },
    recent: (limit) => recentStmt.all(Math.max(1, limit)).map(toEntry),
    clear: () => Number(clearStmt.run().changes),
    count: () => countStmt.get()?.n ?? 0,
  };
};
