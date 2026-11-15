/**
 * The background tasks each thread's turn has running, kept in the database so
 * a bot that dies with them can still say so on its next boot.
 */
import type { DbClient } from "./client.ts";

export type BackgroundJob = {
  readonly channelId: string;
  readonly threadTs: string;
  /** Whose turn started the work; the hand-back runs as them. */
  readonly slackUserId: string;
  readonly tasks: readonly string[];
  readonly updatedAt: number;
};

export type BackgroundJobRepo = {
  /** Replace the thread's live list; an empty list removes the row. */
  set: (job: Omit<BackgroundJob, "updatedAt">, at: number) => void;
  /**
   * Take the thread's row. Returns it only to the one caller that deleted it,
   * so a death is reported by exactly one of the paths that can see it.
   */
  claim: (channelId: string, threadTs: string) => BackgroundJob | undefined;
  list: () => BackgroundJob[];
};

type Row = { channel_id: string; thread_ts: string; slack_user_id: string; tasks: string; updated_at: number };

const toJob = (r: Row): BackgroundJob => {
  let tasks: string[] = [];
  try {
    const v: unknown = JSON.parse(r.tasks);
    if (Array.isArray(v)) tasks = v.filter((t): t is string => typeof t === "string");
  } catch {
    // an unreadable list is an empty one: nothing to report
  }
  return { channelId: r.channel_id, threadTs: r.thread_ts, slackUserId: r.slack_user_id, tasks, updatedAt: r.updated_at };
};

export const createBackgroundJobRepo = (db: DbClient): BackgroundJobRepo => {
  const upsert = db.query(
    `INSERT INTO background_jobs (channel_id, thread_ts, slack_user_id, tasks, updated_at)
     VALUES ($channel, $thread, $user, $tasks, $at)
     ON CONFLICT (channel_id, thread_ts) DO UPDATE SET slack_user_id = $user, tasks = $tasks, updated_at = $at`,
  );
  const remove = db.query<Row, [string, string]>(
    "DELETE FROM background_jobs WHERE channel_id = ? AND thread_ts = ? RETURNING *",
  );
  const all = db.query<Row, []>("SELECT * FROM background_jobs ORDER BY updated_at");
  return {
    set: (job, at) => {
      if (job.tasks.length === 0) {
        remove.get(job.channelId, job.threadTs);
        return;
      }
      upsert.run({ $channel: job.channelId, $thread: job.threadTs, $user: job.slackUserId, $tasks: JSON.stringify(job.tasks), $at: at });
    },
    claim: (channelId, threadTs) => {
      const r = remove.get(channelId, threadTs);
      return r ? toJob(r) : undefined;
    },
    list: () => all.all().map(toJob),
  };
};
