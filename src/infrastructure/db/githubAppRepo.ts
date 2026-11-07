/**
 * GitHub App deliveries and the threads they run in.
 *
 * A delivery row is the dedupe key AND the queue: recorded the moment a real
 * call arrives, handled when nothing is draining, and cleared of its request
 * text once handled because this database is committed.
 */
import type { DbClient } from "./client.ts";

export type DeliveryState = "pending" | "running" | "done" | "failed";

export type PendingDelivery = { readonly id: string; readonly trigger: string };

/** A Slack thread bound to the issue/PR it was opened for. */
export type GithubThread = {
  readonly channelId: string;
  readonly threadTs: string;
  readonly repo: string;
  readonly number: number;
  readonly installationId: number;
  /** Comments posted back through the helper so far. */
  readonly comments: number;
};

export type GithubAppRepo = {
  /** Store a call; false when that delivery id was seen before. */
  record: (id: string, trigger: string, at: number) => boolean;
  /** Pending calls, oldest first, each moved to `running` as it is handed out. */
  claim: (at: number, limit?: number) => PendingDelivery[];
  /** The Slack post exists - from here on a crash must not post it again. */
  markPosted: (id: string, channel: string, ts: string, at: number) => void;
  /** Settle a call and drop its request text. */
  finish: (id: string, state: "done" | "failed", at: number) => void;
  /**
   * After a restart: a call cut off before its Slack post is handed out again,
   * one cut off after it is settled (its turn died with the process).
   */
  recover: (at: number) => { retried: number; settled: number };
  /** Forget settled ids older than `before`; pending ones are kept. */
  prune: (before: number) => void;
  state: (id: string) => DeliveryState | undefined;
  bind: (t: Omit<GithubThread, "comments">, at: number) => void;
  thread: (channelId: string, threadTs: string) => GithubThread | undefined;
  noteComment: (channelId: string, threadTs: string) => void;
};

type ThreadRow = {
  channel_id: string;
  thread_ts: string;
  repo: string;
  number: number;
  installation_id: number;
  comments: number;
};

const STATES: readonly string[] = ["pending", "running", "done", "failed"];

export const createGithubAppRepo = (db: DbClient): GithubAppRepo => {
  const insertStmt = db.query(
    `INSERT OR IGNORE INTO github_app_deliveries (id, trigger, state, received_at, updated_at)
     VALUES ($id, $trigger, 'pending', $at, $at)`,
  );
  const pendingStmt = db.query<{ id: string; trigger: string }, [number]>(
    "SELECT id, trigger FROM github_app_deliveries WHERE state = 'pending' ORDER BY received_at ASC LIMIT ?",
  );
  const runStmt = db.query(
    "UPDATE github_app_deliveries SET state = 'running', updated_at = $at WHERE id = $id AND state = 'pending'",
  );
  const postedStmt = db.query(
    "UPDATE github_app_deliveries SET slack_channel = $channel, slack_ts = $ts, updated_at = $at WHERE id = $id",
  );
  const finishStmt = db.query(
    "UPDATE github_app_deliveries SET state = $state, trigger = '', updated_at = $at WHERE id = $id",
  );
  const retryStmt = db.query(
    "UPDATE github_app_deliveries SET state = 'pending', updated_at = $at WHERE state = 'running' AND slack_ts = ''",
  );
  const settleStmt = db.query(
    "UPDATE github_app_deliveries SET state = 'done', trigger = '', updated_at = $at WHERE state = 'running' AND slack_ts != ''",
  );
  const pruneStmt = db.query("DELETE FROM github_app_deliveries WHERE state != 'pending' AND received_at < $before");
  const stateStmt = db.query<{ state: string }, [string]>("SELECT state FROM github_app_deliveries WHERE id = ?");
  const bindStmt = db.query(
    `INSERT INTO github_app_threads (channel_id, thread_ts, repo, number, installation_id, comments, created_at)
     VALUES ($channel, $ts, $repo, $number, $installation, 0, $at)
     ON CONFLICT(channel_id, thread_ts) DO UPDATE SET
       repo = excluded.repo, number = excluded.number, installation_id = excluded.installation_id`,
  );
  const threadStmt = db.query<ThreadRow, [string, string]>(
    "SELECT * FROM github_app_threads WHERE channel_id = ? AND thread_ts = ?",
  );
  const commentStmt = db.query(
    "UPDATE github_app_threads SET comments = comments + 1 WHERE channel_id = $channel AND thread_ts = $ts",
  );

  return {
    record: (id, trigger, at) => insertStmt.run({ $id: id, $trigger: trigger, $at: at }).changes > 0,
    claim: (at, limit = 10) => {
      const out: PendingDelivery[] = [];
      for (const row of pendingStmt.all(limit)) {
        if (runStmt.run({ $id: row.id, $at: at }).changes > 0) out.push(row);
      }
      return out;
    },
    markPosted: (id, channel, ts, at) => void postedStmt.run({ $id: id, $channel: channel, $ts: ts, $at: at }),
    finish: (id, state, at) => void finishStmt.run({ $id: id, $state: state, $at: at }),
    recover: (at) => ({
      retried: retryStmt.run({ $at: at }).changes,
      settled: settleStmt.run({ $at: at }).changes,
    }),
    prune: (before) => void pruneStmt.run({ $before: before }),
    state: (id) => {
      const s = stateStmt.get(id)?.state;
      return s && STATES.includes(s) ? (s as DeliveryState) : undefined;
    },
    bind: (t, at) =>
      void bindStmt.run({
        $channel: t.channelId,
        $ts: t.threadTs,
        $repo: t.repo,
        $number: t.number,
        $installation: t.installationId,
        $at: at,
      }),
    thread: (channelId, threadTs) => {
      const r = threadStmt.get(channelId, threadTs);
      return r
        ? {
            channelId: r.channel_id,
            threadTs: r.thread_ts,
            repo: r.repo,
            number: r.number,
            installationId: r.installation_id,
            comments: r.comments,
          }
        : undefined;
    },
    noteComment: (channelId, threadTs) => void commentStmt.run({ $channel: channelId, $ts: threadTs }),
  };
};
