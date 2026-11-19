/**
 * Reviews that start by themselves, and the Slack thread each PR keeps.
 *
 * `claim` is the dedupe: one row per PR head sha per identity, so a webhook
 * redelivery, a second poll or a re-request on the same head finds the row and
 * stops. Only a `failed` row can be claimed again (a review the process died
 * in the middle of). See domain/reviewIdentity.ts.
 */
import type { ReviewIdentity, ReviewRunState } from "../../domain/reviewIdentity.ts";
import type { DbClient } from "./client.ts";

export type NewReviewRun = {
  readonly prKey: string;
  readonly headSha: string;
  readonly identity: ReviewIdentity;
  readonly url: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  /** GitHub login of whoever asked. */
  readonly requester: string;
  /** What the asker added next to the request; steers the review. */
  readonly note: string;
  readonly installationId: number;
};

export type ReviewRun = NewReviewRun & {
  readonly id: number;
  readonly state: ReviewRunState;
  /** The Slack person the requester was matched to, "" when nobody. */
  readonly requesterSlack: string;
  readonly askChannel: string;
  readonly askTs: string;
  /** Why the owner was asked: `no-token` or `unknown`. */
  readonly askReason: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type ReviewThread = { readonly channelId: string; readonly threadTs: string };

export type ReviewRunRepo = {
  /** Store a review; undefined when this PR head already has one under this identity (a failed one is taken over). */
  claim: (run: NewReviewRun, at: number) => ReviewRun | undefined;
  get: (id: number) => ReviewRun | undefined;
  /** The review of one head under one identity, whatever state it is in. */
  find: (prKey: string, headSha: string, identity: ReviewIdentity) => ReviewRun | undefined;
  /** Move a review to a state, only from one of `from`; false when it was not in one (someone else moved it). */
  move: (id: number, from: readonly ReviewRunState[], to: ReviewRunState, at: number) => boolean;
  /** Who the requester is on Slack, once known. */
  setRequesterSlack: (id: number, slackId: string, at: number) => void;
  /** The owner's question is posted: where, and why it was needed. */
  setAsk: (id: number, channel: string, ts: string, reason: string, at: number) => void;
  /** After a restart: reviews cut off mid-way cannot finish, so they become claimable again. */
  recover: (at: number) => number;
  thread: (prKey: string) => ReviewThread | undefined;
  /** Keep a PR's thread; the first one wins, so two racing posts never split a PR in two. */
  setThread: (prKey: string, thread: ReviewThread, at: number) => boolean;
};

type Row = {
  id: number;
  pr_key: string;
  head_sha: string;
  identity: string;
  state: string;
  url: string;
  repo: string;
  number: number;
  title: string;
  requester: string;
  requester_slack: string;
  note: string;
  installation_id: number;
  ask_channel: string;
  ask_ts: string;
  ask_reason: string;
  created_at: number;
  updated_at: number;
};

const STATES: readonly string[] = ["claimed", "asking", "running", "done", "failed", "rejected"];

const toRun = (r: Row): ReviewRun => ({
  id: r.id,
  prKey: r.pr_key,
  headSha: r.head_sha,
  identity: r.identity === "app" ? "app" : "human",
  state: (STATES.includes(r.state) ? r.state : "failed") as ReviewRunState,
  url: r.url,
  repo: r.repo,
  number: r.number,
  title: r.title,
  requester: r.requester,
  requesterSlack: r.requester_slack,
  note: r.note,
  installationId: r.installation_id,
  askChannel: r.ask_channel,
  askTs: r.ask_ts,
  askReason: r.ask_reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const createReviewRunRepo = (db: DbClient): ReviewRunRepo => {
  const insertStmt = db.query(
    `INSERT OR IGNORE INTO review_runs
       (pr_key, head_sha, identity, state, url, repo, number, title, requester, note, installation_id, created_at, updated_at)
     VALUES ($prKey, $sha, $identity, 'claimed', $url, $repo, $number, $title, $requester, $note, $installation, $at, $at)`,
  );
  const retakeStmt = db.query(
    `UPDATE review_runs SET state = 'claimed', url = $url, title = $title, requester = $requester, note = $note,
       installation_id = $installation, requester_slack = '', ask_channel = '', ask_ts = '', ask_reason = '', updated_at = $at
     WHERE pr_key = $prKey AND head_sha = $sha AND identity = $identity AND state = 'failed'`,
  );
  const findStmt = db.query<Row, [string, string, string]>(
    "SELECT * FROM review_runs WHERE pr_key = ? AND head_sha = ? AND identity = ?",
  );
  const getStmt = db.query<Row, [number]>("SELECT * FROM review_runs WHERE id = ?");
  const slackStmt = db.query("UPDATE review_runs SET requester_slack = $slack, updated_at = $at WHERE id = $id");
  const askStmt = db.query(
    "UPDATE review_runs SET ask_channel = $channel, ask_ts = $ts, ask_reason = $reason, updated_at = $at WHERE id = $id",
  );
  const recoverStmt = db.query(
    "UPDATE review_runs SET state = 'failed', updated_at = $at WHERE state IN ('claimed', 'running')",
  );
  const threadStmt = db.query<{ channel_id: string; thread_ts: string }, [string]>(
    "SELECT channel_id, thread_ts FROM review_threads WHERE pr_key = ?",
  );
  const threadInsert = db.query(
    "INSERT OR IGNORE INTO review_threads (pr_key, channel_id, thread_ts, created_at) VALUES ($prKey, $channel, $ts, $at)",
  );

  return {
    claim: (run, at) => {
      const params = {
        $prKey: run.prKey,
        $sha: run.headSha,
        $identity: run.identity,
        $url: run.url,
        $repo: run.repo,
        $number: run.number,
        $title: run.title,
        $requester: run.requester,
        $note: run.note,
        $installation: run.installationId,
        $at: at,
      };
      const fresh = insertStmt.run(params).changes > 0;
      if (!fresh && retakeStmt.run(params).changes === 0) return undefined;
      const row = findStmt.get(run.prKey, run.headSha, run.identity);
      return row ? toRun(row) : undefined;
    },
    get: (id) => {
      const r = getStmt.get(id);
      return r ? toRun(r) : undefined;
    },
    find: (prKey, headSha, identity) => {
      const r = findStmt.get(prKey, headSha, identity);
      return r ? toRun(r) : undefined;
    },
    move: (id, from, to, at) => {
      if (from.length === 0) return false;
      const marks = from.map(() => "?").join(", ");
      const res = db.query(`UPDATE review_runs SET state = ?, updated_at = ? WHERE id = ? AND state IN (${marks})`).run(to, at, id, ...from);
      return res.changes > 0;
    },
    setRequesterSlack: (id, slackId, at) => void slackStmt.run({ $id: id, $slack: slackId, $at: at }),
    setAsk: (id, channel, ts, reason, at) => void askStmt.run({ $id: id, $channel: channel, $ts: ts, $reason: reason, $at: at }),
    recover: (at) => recoverStmt.run({ $at: at }).changes,
    thread: (prKey) => {
      const r = threadStmt.get(prKey);
      return r ? { channelId: r.channel_id, threadTs: r.thread_ts } : undefined;
    },
    setThread: (prKey, thread, at) =>
      threadInsert.run({ $prKey: prKey, $channel: thread.channelId, $ts: thread.threadTs, $at: at }).changes > 0,
  };
};
