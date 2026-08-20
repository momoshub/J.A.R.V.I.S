/**
 * Message repository - the bot's conversation memory, keyed by channel.
 */
import type { DbClient } from "./client.ts";
import type {
  MessageRole,
  NewMessage,
  StoredMessage,
} from "../../domain/types.ts";

type Row = {
  id: number;
  channel_id: string;
  slack_user_id: string;
  role: MessageRole;
  content: string;
  created_at: number;
  slack_ts: string;
  thread_ts: string;
};

const toMessage = (row: Row): StoredMessage => ({
  id: row.id,
  channelId: row.channel_id,
  slackUserId: row.slack_user_id,
  role: row.role,
  content: row.content,
  createdAt: row.created_at,
  ...(row.slack_ts ? { slackTs: row.slack_ts } : {}),
  ...(row.thread_ts ? { threadTs: row.thread_ts } : {}),
});

/** A channel summary for the dashboard's conversation browser. */
export type ChannelSummary = {
  channelId: string;
  count: number;
  lastAt: number;
};

export type MessageRepo = {
  append: (message: NewMessage, createdAt: number) => StoredMessage;
  /** Recent turns for a channel, returned oldest-first. Every thread in it. */
  recentForChannel: (channelId: string, limit: number) => StoredMessage[];
  /**
   * Recent turns for one thread, oldest-first - the window the brain actually
   * gets, so a conversation cannot bleed into an unrelated one next door.
   */
  recentForThread: (channelId: string, threadTs: string, limit: number) => StoredMessage[];
  clearChannel: (channelId: string) => number;
  count: () => number;
  /** Distinct channels with a turn count, most-recently-active first. */
  channels: () => ChannelSummary[];
};

export const createMessageRepo = (db: DbClient): MessageRepo => {
  const insertStmt = db.query(
    `INSERT INTO messages (channel_id, slack_user_id, role, content, created_at, slack_ts, thread_ts)
     VALUES ($channelId, $slackUserId, $role, $content, $createdAt, $slackTs, $threadTs)
     RETURNING *`,
  );
  const recentStmt = db.query<Row, [string, number]>(
    `SELECT * FROM (
       SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?
     ) ORDER BY id ASC`,
  );
  const recentThreadStmt = db.query<Row, [string, string, number]>(
    `SELECT * FROM (
       SELECT * FROM messages WHERE channel_id = ? AND thread_ts = ? ORDER BY id DESC LIMIT ?
     ) ORDER BY id ASC`,
  );
  const clearStmt = db.query("DELETE FROM messages WHERE channel_id = $channelId");
  const countStmt = db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM messages",
  );
  const channelsStmt = db.query<{ channel_id: string; n: number; last_at: number }, []>(
    `SELECT channel_id, COUNT(*) AS n, MAX(created_at) AS last_at
     FROM messages GROUP BY channel_id ORDER BY last_at DESC`,
  );

  return {
    append: (message, createdAt) => {
      const row = insertStmt.get({
        $channelId: message.channelId,
        $slackUserId: message.slackUserId,
        $role: message.role,
        $content: message.content,
        $createdAt: createdAt,
        $slackTs: message.slackTs ?? "",
        $threadTs: message.threadTs ?? "",
      }) as Row;
      return toMessage(row);
    },
    recentForChannel: (channelId, limit) =>
      recentStmt.all(channelId, Math.max(0, limit)).map(toMessage),
    recentForThread: (channelId, threadTs, limit) =>
      recentThreadStmt.all(channelId, threadTs, Math.max(0, limit)).map(toMessage),
    clearChannel: (channelId) => {
      const res = clearStmt.run({ $channelId: channelId });
      return Number(res.changes);
    },
    count: () => countStmt.get()?.n ?? 0,
    channels: () =>
      channelsStmt
        .all()
        .map((r) => ({ channelId: r.channel_id, count: r.n, lastAt: r.last_at })),
  };
};
