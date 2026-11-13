/**
 * Thread briefs - notes one thread's session leaves for another's.
 *
 * `add` stores the note and records the link in both directions, so either
 * thread can later answer the other by the opaque reference it was shown.
 * `unread` and `markRead` are split on purpose: a turn marks only the briefs it
 * was handed, and only after it ran, so a failed or cut turn keeps them.
 */
import type { DbClient } from "./client.ts";
import { briefRef } from "../../domain/threadBrief.ts";

export type ThreadBrief = {
  id: number;
  fromChannel: string;
  fromThread: string;
  toChannel: string;
  toThread: string;
  /** Slack id of whoever ran `brief`. */
  author: string;
  text: string;
  createdAt: number;
  /** Unset until a turn in the target thread has run with it. */
  readAt?: number;
};

export type NewBrief = Omit<ThreadBrief, "id" | "createdAt" | "readAt">;

export type ThreadPeer = { channelId: string; threadTs: string };

export type ThreadBriefRepo = {
  /** Store a brief and link the two threads. Returns its id. */
  add: (brief: NewBrief, now: number) => number;
  /** Briefs for this thread nobody has read yet, oldest first. */
  unread: (channelId: string, threadTs: string) => ThreadBrief[];
  /** Mark these read; ones already read keep their first time. */
  markRead: (ids: readonly number[], now: number) => void;
  /** The thread a reference names, among those this thread is linked to. */
  peer: (channelId: string, threadTs: string, ref: string) => ThreadPeer | undefined;
};

type Row = {
  id: number;
  from_channel: string;
  from_thread: string;
  to_channel: string;
  to_thread: string;
  author: string;
  text: string;
  created_at: number;
  read_at: number | null;
};

const toBrief = (r: Row): ThreadBrief => ({
  id: r.id,
  fromChannel: r.from_channel,
  fromThread: r.from_thread,
  toChannel: r.to_channel,
  toThread: r.to_thread,
  author: r.author,
  text: r.text,
  createdAt: r.created_at,
  ...(r.read_at === null ? {} : { readAt: r.read_at }),
});

export const createThreadBriefRepo = (db: DbClient): ThreadBriefRepo => {
  const insert = db.query<{ id: number }, Record<string, string | number>>(
    `INSERT INTO thread_briefs (from_channel, from_thread, to_channel, to_thread, author, text, created_at)
     VALUES ($fromChannel, $fromThread, $toChannel, $toThread, $author, $text, $now)
     RETURNING id`,
  );
  const link = db.query(
    `INSERT INTO thread_brief_links (channel_id, thread_ts, peer_channel, peer_thread, ref, created_at)
     VALUES ($channel, $thread, $peerChannel, $peerThread, $ref, $now)
     ON CONFLICT(channel_id, thread_ts, peer_channel, peer_thread) DO NOTHING`,
  );
  const unreadStmt = db.query<Row, [string, string]>(
    `SELECT id, from_channel, from_thread, to_channel, to_thread, author, text, created_at, read_at
     FROM thread_briefs WHERE to_channel = ? AND to_thread = ? AND read_at IS NULL ORDER BY id`,
  );
  const readStmt = db.query("UPDATE thread_briefs SET read_at = $now WHERE id = $id AND read_at IS NULL");
  const peerStmt = db.query<{ peer_channel: string; peer_thread: string }, [string, string, string]>(
    "SELECT peer_channel, peer_thread FROM thread_brief_links WHERE channel_id = ? AND thread_ts = ? AND ref = ?",
  );

  const addAll = db.transaction((b: NewBrief, now: number): number => {
    const row = insert.get({
      $fromChannel: b.fromChannel,
      $fromThread: b.fromThread,
      $toChannel: b.toChannel,
      $toThread: b.toThread,
      $author: b.author,
      $text: b.text,
      $now: now,
    });
    // Each side learns the other by the reference it will be shown.
    link.run({
      $channel: b.toChannel,
      $thread: b.toThread,
      $peerChannel: b.fromChannel,
      $peerThread: b.fromThread,
      $ref: briefRef(b.fromChannel, b.fromThread),
      $now: now,
    });
    link.run({
      $channel: b.fromChannel,
      $thread: b.fromThread,
      $peerChannel: b.toChannel,
      $peerThread: b.toThread,
      $ref: briefRef(b.toChannel, b.toThread),
      $now: now,
    });
    return row?.id ?? 0;
  });
  const markAll = db.transaction((ids: readonly number[], now: number) => {
    for (const id of ids) readStmt.run({ $id: id, $now: now });
  });

  return {
    add: (brief, now) => addAll(brief, now),
    unread: (channelId, threadTs) => unreadStmt.all(channelId, threadTs).map(toBrief),
    markRead: (ids, now) => {
      if (ids.length > 0) markAll(ids, now);
    },
    peer: (channelId, threadTs, ref) => {
      const row = peerStmt.get(channelId, threadTs, ref);
      return row ? { channelId: row.peer_channel, threadTs: row.peer_thread } : undefined;
    },
  };
};
