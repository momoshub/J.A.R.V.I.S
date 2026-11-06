/**
 * Threads the bot was asked to keep up with.
 *
 * Membership is checked on every untagged message in a thread, so it is held
 * in memory and refreshed on write: the alternative is a SELECT per line of
 * every busy channel the bot can see, for an answer that changes about twice
 * a week.
 */
import type { DbClient } from "./client.ts";

export type FollowedThread = {
  readonly channelId: string;
  readonly threadTs: string;
  readonly addedBy: string;
  readonly createdAt: number;
};

type Row = { channel_id: string; thread_ts: string; added_by: string; created_at: number };

const toFollowed = (r: Row): FollowedThread => ({
  channelId: r.channel_id,
  threadTs: r.thread_ts,
  addedBy: r.added_by,
  createdAt: r.created_at,
});

export type FollowRepo = {
  /** Hot path: is this thread one it keeps up with? */
  isFollowed: (channelId: string, threadTs: string) => boolean;
  /** Someone asked for it, so it also lifts an earlier "off". */
  add: (channelId: string, threadTs: string, by: string, at: number) => void;
  /**
   * Follow a thread on its own accord - a one-on-one. Never over an "off":
   * returns true only when it actually started following.
   */
  autoAdd: (channelId: string, threadTs: string, by: string, at: number) => boolean;
  /** Told to stop here, so no one-on-one turns it back on. */
  isOptedOut: (channelId: string, threadTs: string) => boolean;
  /**
   * Stop following, and remember it was turned off. Returns false when it was
   * not being followed in the first place.
   */
  remove: (channelId: string, threadTs: string, at?: number) => boolean;
  list: (limit?: number) => FollowedThread[];
  count: () => number;
};

const key = (channelId: string, threadTs: string): string => `${channelId}:${threadTs}`;

export const createFollowRepo = (db: DbClient): FollowRepo => {
  const insertStmt = db.query(
    `INSERT INTO followed_threads (channel_id, thread_ts, added_by, created_at)
     VALUES ($channelId, $threadTs, $by, $at)
     ON CONFLICT (channel_id, thread_ts) DO NOTHING`,
  );
  const deleteStmt = db.query(
    "DELETE FROM followed_threads WHERE channel_id = $channelId AND thread_ts = $threadTs",
  );
  const listStmt = db.query<Row, [number]>(
    "SELECT * FROM followed_threads ORDER BY created_at DESC LIMIT ?",
  );
  const allStmt = db.query<Row, []>("SELECT * FROM followed_threads");
  const optOutStmt = db.query(
    `INSERT INTO unfollowed_threads (channel_id, thread_ts, created_at)
     VALUES ($channelId, $threadTs, $at)
     ON CONFLICT (channel_id, thread_ts) DO NOTHING`,
  );
  const optInStmt = db.query(
    "DELETE FROM unfollowed_threads WHERE channel_id = $channelId AND thread_ts = $threadTs",
  );
  const allOffStmt = db.query<{ channel_id: string; thread_ts: string }, []>(
    "SELECT channel_id, thread_ts FROM unfollowed_threads",
  );

  const live = new Set<string>(allStmt.all().map((r) => key(r.channel_id, r.thread_ts)));
  const off = new Set<string>(allOffStmt.all().map((r) => key(r.channel_id, r.thread_ts)));

  const follow = (channelId: string, threadTs: string, by: string, at: number): void => {
    insertStmt.run({ $channelId: channelId, $threadTs: threadTs, $by: by, $at: at });
    live.add(key(channelId, threadTs));
  };

  return {
    isFollowed: (channelId, threadTs) => live.has(key(channelId, threadTs)),
    add: (channelId, threadTs, by, at) => {
      off.delete(key(channelId, threadTs));
      optInStmt.run({ $channelId: channelId, $threadTs: threadTs });
      follow(channelId, threadTs, by, at);
    },
    autoAdd: (channelId, threadTs, by, at) => {
      const k = key(channelId, threadTs);
      if (live.has(k) || off.has(k)) return false;
      follow(channelId, threadTs, by, at);
      return true;
    },
    isOptedOut: (channelId, threadTs) => off.has(key(channelId, threadTs)),
    remove: (channelId, threadTs, at = Date.now()) => {
      const had = live.delete(key(channelId, threadTs));
      deleteStmt.run({ $channelId: channelId, $threadTs: threadTs });
      off.add(key(channelId, threadTs));
      optOutStmt.run({ $channelId: channelId, $threadTs: threadTs, $at: at });
      return had;
    },
    list: (limit = 50) => listStmt.all(Math.max(1, limit)).map(toFollowed),
    count: () => live.size,
  };
};
