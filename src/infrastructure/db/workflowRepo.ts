/**
 * Workflow repository - the long-running CLI sessions bound to a Slack thread.
 *
 * A workflow is a thread plus the CLI session id driving it. Keeping the id here
 * rather than in memory means a workflow outlives a bot restart: the next
 * message in the thread resumes the same session, with its context intact.
 */
import type { DbClient } from "./client.ts";
import type { Workflow } from "../../domain/types.ts";

type Row = {
  id: number;
  channel_id: string;
  thread_ts: string;
  session_id: string;
  task: string;
  started_by: string;
  status: string;
  turns: number;
  auto_turns: number;
  continue_as: string | null;
  continue_seq: number;
  created_at: number;
  updated_at: number;
};

const toWorkflow = (row: Row): Workflow => ({
  id: row.id,
  channelId: row.channel_id,
  threadTs: row.thread_ts,
  sessionId: row.session_id,
  task: row.task,
  startedBy: row.started_by,
  status: row.status === "active" ? "active" : "stopped",
  turns: row.turns,
  autoTurns: row.auto_turns ?? 0,
  ...(row.continue_as ? { continueAs: row.continue_as } : {}),
  continueSeq: row.continue_seq ?? 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export type NewWorkflow = {
  channelId: string;
  threadTs: string;
  sessionId: string;
  task: string;
  startedBy: string;
};

export type WorkflowRepo = {
  start: (w: NewWorkflow, at: number) => Workflow;
  /** The live workflow driving this thread, if any. */
  activeFor: (channelId: string, threadTs: string) => Workflow | undefined;
  /** Count a completed turn, so `status` can show how far it has got. */
  recordTurn: (id: number, at: number) => void;
  /** End it. Returns false when there was nothing live to end. */
  stop: (id: number, at: number) => boolean;
  /** Live workflows, most recently used first. */
  listActive: () => Workflow[];
  /** One workflow by id, live or not. */
  get: (id: number) => Workflow | undefined;
  /**
   * Record that the next step should run as `slackId`. Returns the request's
   * sequence number, which the timer must present to claim it, or undefined
   * when the workflow is no longer live.
   */
  requestContinue: (id: number, slackId: string, at: number) => number | undefined;
  /**
   * Claim a pending step: clears the request and counts it as a step taken on
   * its own. False when it was cancelled, superseded or the workflow ended.
   */
  takeContinue: (id: number, seq: number, at: number) => boolean;
  /** Drop any pending step - the turn ended without asking for one. */
  clearContinue: (id: number) => void;
  /** A human spoke: drop any pending step and start the count again. */
  humanTurn: (id: number) => void;
};

export const createWorkflowRepo = (db: DbClient): WorkflowRepo => {
  const insertStmt = db.query(
    `INSERT INTO workflows (channel_id, thread_ts, session_id, task, started_by, status, turns, created_at, updated_at)
     VALUES ($channelId, $threadTs, $sessionId, $task, $startedBy, 'active', 0, $at, $at)
     RETURNING *`,
  );
  const activeStmt = db.query<Row, [string, string]>(
    "SELECT * FROM workflows WHERE channel_id = ? AND thread_ts = ? AND status = 'active'",
  );
  const turnStmt = db.query(
    "UPDATE workflows SET turns = turns + 1, updated_at = $at WHERE id = $id AND status = 'active'",
  );
  const stopStmt = db.query(
    "UPDATE workflows SET status = 'stopped', continue_as = NULL, updated_at = $at WHERE id = $id AND status = 'active'",
  );
  const getStmt = db.query<Row, [number]>("SELECT * FROM workflows WHERE id = ?");
  const requestStmt = db.query<{ continue_seq: number }, Record<string, string | number>>(
    `UPDATE workflows SET continue_as = $as, continue_seq = continue_seq + 1, updated_at = $at
     WHERE id = $id AND status = 'active' RETURNING continue_seq`,
  );
  const takeStmt = db.query(
    `UPDATE workflows SET continue_as = NULL, auto_turns = auto_turns + 1, updated_at = $at
     WHERE id = $id AND status = 'active' AND continue_as IS NOT NULL AND continue_seq = $seq`,
  );
  const clearStmt = db.query("UPDATE workflows SET continue_as = NULL WHERE id = $id");
  const humanStmt = db.query("UPDATE workflows SET continue_as = NULL, auto_turns = 0 WHERE id = $id");
  const listStmt = db.query<Row, []>(
    "SELECT * FROM workflows WHERE status = 'active' ORDER BY updated_at DESC",
  );

  return {
    start: (w, at) =>
      toWorkflow(
        insertStmt.get({
          $channelId: w.channelId,
          $threadTs: w.threadTs,
          $sessionId: w.sessionId,
          $task: w.task,
          $startedBy: w.startedBy,
          $at: at,
        }) as Row,
      ),
    activeFor: (channelId, threadTs) => {
      const row = activeStmt.get(channelId, threadTs);
      return row ? toWorkflow(row) : undefined;
    },
    recordTurn: (id, at) => {
      turnStmt.run({ $id: id, $at: at });
    },
    stop: (id, at) => Number(stopStmt.run({ $id: id, $at: at }).changes) > 0,
    listActive: () => listStmt.all().map(toWorkflow),
    get: (id) => {
      const row = getStmt.get(id);
      return row ? toWorkflow(row) : undefined;
    },
    requestContinue: (id, slackId, at) =>
      requestStmt.get({ $id: id, $as: slackId, $at: at })?.continue_seq ?? undefined,
    takeContinue: (id, seq, at) => Number(takeStmt.run({ $id: id, $seq: seq, $at: at }).changes) > 0,
    clearContinue: (id) => {
      clearStmt.run({ $id: id });
    },
    humanTurn: (id) => {
      humanStmt.run({ $id: id });
    },
  };
};
