/**
 * Message repository - E.V.'s conversation memory, keyed by channel.
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
};

const toMessage = (row: Row): StoredMessage => ({
  id: row.id,
  channelId: row.channel_id,
  slackUserId: row.slack_user_id,
  role: row.role,
  content: row.content,
  createdAt: row.created_at,
});

export type MessageRepo = {
  append: (message: NewMessage, createdAt: number) => StoredMessage;
  /** Recent turns for a channel, returned oldest-first. */
  recentForChannel: (channelId: string, limit: number) => StoredMessage[];
  clearChannel: (channelId: string) => number;
  count: () => number;
};

export const createMessageRepo = (db: DbClient): MessageRepo => {
  const insertStmt = db.query(
    `INSERT INTO messages (channel_id, slack_user_id, role, content, created_at)
     VALUES ($channelId, $slackUserId, $role, $content, $createdAt)
     RETURNING *`,
  );
  const recentStmt = db.query<Row, [string, number]>(
    `SELECT * FROM (
       SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?
     ) ORDER BY id ASC`,
  );
  const clearStmt = db.query("DELETE FROM messages WHERE channel_id = $channelId");
  const countStmt = db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM messages",
  );

  return {
    append: (message, createdAt) => {
      const row = insertStmt.get({
        $channelId: message.channelId,
        $slackUserId: message.slackUserId,
        $role: message.role,
        $content: message.content,
        $createdAt: createdAt,
      }) as Row;
      return toMessage(row);
    },
    recentForChannel: (channelId, limit) =>
      recentStmt.all(channelId, Math.max(0, limit)).map(toMessage),
    clearChannel: (channelId) => {
      const res = clearStmt.run({ $channelId: channelId });
      return Number(res.changes);
    },
    count: () => countStmt.get()?.n ?? 0,
  };
};
