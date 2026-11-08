/**
 * Which Slack thread started each Orca worker, and which worker questions have
 * been put to it.
 *
 * Durable on purpose: a worker can wait hours on its question, the bot
 * restarts in between, and a question forgotten across a restart is a worker
 * that waits forever - the failure this exists to end. A question delivered
 * twice is the other failure, so its row is written before the turn starts.
 */
import type { DbClient } from "./client.ts";

export type OrcaThread = {
  readonly channelId: string;
  readonly threadTs: string;
  /** Whose turn started the worker; the question turn runs as them. */
  readonly slackUserId: string;
};

export type OrcaQuestionState = "delivering" | "delivered" | "answered" | "closed" | "refused" | "gave_up";

export type OrcaQuestionRow = {
  readonly messageId: string;
  readonly runId: string;
  readonly dispatchId: string;
  readonly state: OrcaQuestionState;
  readonly attempts: number;
};

export type OrcaQuestionRepo = {
  /** Remember the thread an id (`run_...` / `ctx_...`) came from. The first thread keeps it. */
  link: (orcaId: string, thread: OrcaThread, at: number) => void;
  threadOf: (orcaId: string) => OrcaThread | undefined;
  /** Run ids linked at or after `since`, newest first. */
  runsSince: (since: number, limit?: number) => string[];
  question: (messageId: string) => OrcaQuestionRow | undefined;
  /**
   * Write a question's row in `state`, attempts 1 for `delivering`. False when
   * it already had one - someone else got there first, so do nothing.
   */
  record: (
    q: { messageId: string; runId: string; dispatchId: string },
    thread: OrcaThread,
    state: OrcaQuestionState,
    at: number,
  ) => boolean;
  /** One more try at a delivery that was cut; returns the new attempt count. */
  retry: (messageId: string, at: number) => number;
  settle: (messageId: string, state: OrcaQuestionState, at: number) => void;
};

type ThreadRow = { channel_id: string; thread_ts: string; slack_user_id: string };
type QuestionRow = { message_id: string; run_id: string; dispatch_id: string; state: string; attempts: number };

const STATES: readonly string[] = ["delivering", "delivered", "answered", "closed", "refused", "gave_up"];
// An unknown state is treated as done: never deliver on a row nobody can read.
const asState = (v: string): OrcaQuestionState => (STATES.includes(v) ? (v as OrcaQuestionState) : "delivered");

export const createOrcaQuestionRepo = (db: DbClient): OrcaQuestionRepo => {
  const linkStmt = db.query(
    `INSERT OR IGNORE INTO orca_threads (orca_id, channel_id, thread_ts, slack_user_id, created_at)
     VALUES ($id, $channelId, $threadTs, $slackUserId, $at)`,
  );
  const threadStmt = db.query<ThreadRow, [string]>(
    "SELECT channel_id, thread_ts, slack_user_id FROM orca_threads WHERE orca_id = ?",
  );
  const runsStmt = db.query<{ orca_id: string }, [number, number]>(
    "SELECT orca_id FROM orca_threads WHERE orca_id LIKE 'run\\_%' ESCAPE '\\' AND created_at >= ? ORDER BY created_at DESC LIMIT ?",
  );
  const questionStmt = db.query<QuestionRow, [string]>(
    "SELECT message_id, run_id, dispatch_id, state, attempts FROM orca_questions WHERE message_id = ?",
  );
  const recordStmt = db.query(
    `INSERT OR IGNORE INTO orca_questions
       (message_id, run_id, dispatch_id, channel_id, thread_ts, state, attempts, created_at, updated_at)
     VALUES ($messageId, $runId, $dispatchId, $channelId, $threadTs, $state, $attempts, $at, $at)`,
  );
  const retryStmt = db.query<{ attempts: number }, [number, string]>(
    "UPDATE orca_questions SET attempts = attempts + 1, updated_at = ? WHERE message_id = ? RETURNING attempts",
  );
  const settleStmt = db.query("UPDATE orca_questions SET state = $state, updated_at = $at WHERE message_id = $id");

  return {
    link: (orcaId, t, at) =>
      void linkStmt.run({ $id: orcaId, $channelId: t.channelId, $threadTs: t.threadTs, $slackUserId: t.slackUserId, $at: at }),
    threadOf: (orcaId) => {
      const r = threadStmt.get(orcaId);
      return r ? { channelId: r.channel_id, threadTs: r.thread_ts, slackUserId: r.slack_user_id } : undefined;
    },
    runsSince: (since, limit = 50) => runsStmt.all(since, Math.max(1, limit)).map((r) => r.orca_id),
    question: (messageId) => {
      const r = questionStmt.get(messageId);
      return r
        ? { messageId: r.message_id, runId: r.run_id, dispatchId: r.dispatch_id, state: asState(r.state), attempts: r.attempts }
        : undefined;
    },
    record: (q, t, state, at) =>
      Number(
        recordStmt.run({
          $messageId: q.messageId,
          $runId: q.runId,
          $dispatchId: q.dispatchId,
          $channelId: t.channelId,
          $threadTs: t.threadTs,
          $state: state,
          $attempts: state === "delivering" ? 1 : 0,
          $at: at,
        }).changes,
      ) > 0,
    retry: (messageId, at) => retryStmt.get(at, messageId)?.attempts ?? 0,
    settle: (messageId, state, at) => void settleStmt.run({ $id: messageId, $state: state, $at: at }),
  };
};
