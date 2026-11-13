/**
 * Thread briefs - notes one thread's session leaves for another's.
 *
 * `add` stores the note and records the link in both directions, so either
 * thread can later answer the other by the opaque reference it was shown.
 * `unread` and `markRead` are split on purpose: a turn marks only the briefs it
 * was handed, and only after it ran, so a failed or cut turn keeps them. Read
 * state is per access tier, because each tier is its own CLI session: a brief a
 * turn carried is in THAT session's transcript and nowhere else. `recent` is for
 * a session with no transcript yet (cold start, a dropped session), which has
 * seen none of them whatever was read before.
 */
import { randomBytes } from "node:crypto";
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
};

export type NewBrief = Omit<ThreadBrief, "id" | "createdAt">;

export type ThreadPeer = { channelId: string; threadTs: string };

export type ThreadBriefRepo = {
  /** Store a brief and link the two threads. Returns its id. */
  add: (brief: NewBrief, now: number) => number;
  /** Briefs for this thread that no turn in this tier has carried yet, oldest first. */
  unread: (channelId: string, threadTs: string, tier: string) => ThreadBrief[];
  /** The newest briefs for this thread, read or not, oldest first. */
  recent: (channelId: string, threadTs: string, limit: number) => ThreadBrief[];
  /** Mark these read for this tier; ones already read keep their first time. */
  markRead: (ids: readonly number[], tier: string, now: number) => void;
  /** The opaque reference of a thread, as shown to the threads it briefs. */
  ref: (channelId: string, threadTs: string) => string;
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
  const COLS = "b.id, b.from_channel, b.from_thread, b.to_channel, b.to_thread, b.author, b.text, b.created_at";
  const unreadStmt = db.query<Row, [string, string, string]>(
    `SELECT ${COLS} FROM thread_briefs b
     WHERE b.to_channel = ? AND b.to_thread = ?
       AND NOT EXISTS (SELECT 1 FROM thread_brief_reads r WHERE r.brief_id = b.id AND r.tier = ?)
     ORDER BY b.id`,
  );
  const recentStmt = db.query<Row, [string, string, number]>(
    `SELECT * FROM (SELECT ${COLS} FROM thread_briefs b WHERE b.to_channel = ? AND b.to_thread = ? ORDER BY b.id DESC LIMIT ?) ORDER BY id`,
  );
  const readStmt = db.query(
    "INSERT INTO thread_brief_reads (brief_id, tier, read_at) VALUES ($id, $tier, $now) ON CONFLICT(brief_id, tier) DO NOTHING",
  );
  const secretGet = db.query<{ secret: string }, []>("SELECT secret FROM thread_brief_secret WHERE id = 1");
  const secretPut = db.query("INSERT INTO thread_brief_secret (id, secret) VALUES (1, $secret) ON CONFLICT(id) DO NOTHING");
  // Minted on first use and kept: a reference stored in the link table must keep
  // resolving across restarts. Re-read after the insert so two racing writers agree.
  let secret: string | undefined;
  const ref = (channelId: string, threadTs: string): string => {
    if (!secret) {
      secretPut.run({ $secret: randomBytes(32).toString("hex") });
      secret = secretGet.get()?.secret ?? "";
    }
    return briefRef(secret, channelId, threadTs);
  };
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
      $ref: ref(b.fromChannel, b.fromThread),
      $now: now,
    });
    link.run({
      $channel: b.fromChannel,
      $thread: b.fromThread,
      $peerChannel: b.toChannel,
      $peerThread: b.toThread,
      $ref: ref(b.toChannel, b.toThread),
      $now: now,
    });
    return row?.id ?? 0;
  });
  const markAll = db.transaction((ids: readonly number[], tier: string, now: number) => {
    for (const id of ids) readStmt.run({ $id: id, $tier: tier, $now: now });
  });

  return {
    add: (brief, now) => addAll(brief, now),
    unread: (channelId, threadTs, tier) => unreadStmt.all(channelId, threadTs, tier).map(toBrief),
    recent: (channelId, threadTs, limit) => recentStmt.all(channelId, threadTs, Math.max(0, limit)).map(toBrief),
    markRead: (ids, tier, now) => {
      if (ids.length > 0) markAll(ids, tier, now);
    },
    ref,
    peer: (channelId, threadTs, ref) => {
      const row = peerStmt.get(channelId, threadTs, ref);
      return row ? { channelId: row.peer_channel, threadTs: row.peer_thread } : undefined;
    },
  };
};
