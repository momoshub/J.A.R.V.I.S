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

/** A page of turns, oldest-first, and where the next (older) page starts. */
export type MessagePage = {
  messages: StoredMessage[];
  /** Pass as `before` for the page above this one; absent at the very first turn. */
  nextBefore?: number;
};

/** A page of channels, most-recently-active first, and the cursor for the next one. */
export type ChannelPage = {
  channels: ChannelSummary[];
  nextCursor?: string;
};

/** `<lastAt>:<channelId>` - the last row of a page, which the next page starts after. */
export const channelCursor = (c: ChannelSummary): string => `${c.lastAt}:${c.channelId}`;
const parseChannelCursor = (cursor: string | undefined): { lastAt: number; channelId: string } | undefined => {
  const at = cursor?.indexOf(":") ?? -1;
  if (!cursor || at < 1) return undefined;
  const lastAt = Number(cursor.slice(0, at));
  return Number.isFinite(lastAt) ? { lastAt, channelId: cursor.slice(at + 1) } : undefined;
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
  /** One page of `channels()`, continuing after `cursor` (from the previous page's `nextCursor`). */
  channelsPage: (cursor: string | undefined, limit: number) => ChannelPage;
  /**
   * Up to `limit` turns of a channel older than message id `before` (newest
   * page when absent), returned oldest-first - one screen of a conversation,
   * read upwards.
   */
  pageForChannel: (channelId: string, before: number | undefined, limit: number) => MessagePage;
  /** How many turns a channel holds. */
  countForChannel: (channelId: string) => number;
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

  type ChannelRow = { channel_id: string; n: number; last_at: number };
  const channelsFirstStmt = db.query<ChannelRow, [number]>(
    `SELECT channel_id, COUNT(*) AS n, MAX(created_at) AS last_at
     FROM messages GROUP BY channel_id ORDER BY last_at DESC, channel_id DESC LIMIT ?`,
  );
  const channelsAfterStmt = db.query<ChannelRow, [number, number, string, number]>(
    `SELECT channel_id, COUNT(*) AS n, MAX(created_at) AS last_at
     FROM messages GROUP BY channel_id
     HAVING last_at < ?1 OR (last_at = ?2 AND channel_id < ?3)
     ORDER BY last_at DESC, channel_id DESC LIMIT ?4`,
  );
  const pageStmt = db.query<Row, [string, number, number]>(
    `SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
  );
  const channelCountStmt = db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?",
  );
  const toSummary = (r: ChannelRow): ChannelSummary => ({ channelId: r.channel_id, count: r.n, lastAt: r.last_at });

  return {
    channelsPage: (cursor, limit) => {
      const size = Math.max(1, limit);
      const after = parseChannelCursor(cursor);
      // One extra row says whether there is a next page without a COUNT.
      const rows = after
        ? channelsAfterStmt.all(after.lastAt, after.lastAt, after.channelId, size + 1)
        : channelsFirstStmt.all(size + 1);
      const channels = rows.slice(0, size).map(toSummary);
      const last = channels[channels.length - 1];
      return rows.length > size && last ? { channels, nextCursor: channelCursor(last) } : { channels };
    },
    pageForChannel: (channelId, before, limit) => {
      const size = Math.max(1, limit);
      const rows = pageStmt.all(channelId, before ?? Number.MAX_SAFE_INTEGER, size + 1);
      const messages = rows.slice(0, size).map(toMessage).reverse();
      const oldest = messages[0];
      return rows.length > size && oldest ? { messages, nextBefore: oldest.id } : { messages };
    },
    countForChannel: (channelId) => channelCountStmt.get(channelId)?.n ?? 0,
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
