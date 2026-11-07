/**
 * Workflow repository - the long-running CLI sessions bound to a Slack thread.
 *
 * A workflow is a thread plus the CLI session id driving it. Keeping the id here
 * rather than in memory means a workflow outlives a bot restart: the next
 * message in the thread resumes the same session, with its context intact.
 */
import type { DbClient } from "./client.ts";
import type { WorkerReply, Workflow, WorkflowSteer } from "../../domain/types.ts";
import { keepReplies } from "../../domain/workflowFront.ts";

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
  front_session_id: string | null;
  steers: string | null;
  worker_replies: string | null;
  created_at: number;
  updated_at: number;
};

/** A JSON list column; anything unreadable is an empty list, never a crash. */
const parseList = (raw: string | null): unknown[] => {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isSteer = (v: unknown): v is WorkflowSteer =>
  isRecord(v) && typeof v.by === "string" && typeof v.text === "string" && typeof v.at === "number";
const isReply = (v: unknown): v is WorkerReply =>
  isRecord(v) && typeof v.text === "string" && typeof v.at === "number";

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
  ...(row.front_session_id ? { frontSessionId: row.front_session_id } : {}),
  steers: parseList(row.steers).filter(isSteer),
  workerReplies: parseList(row.worker_replies).filter(isReply),
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
  /** It was steered: the count of steps taken on its own starts again. */
  resetAutoTurns: (id: number) => void;
  /** Claim the front's session id on its first turn. False if one is already set. */
  setFrontSession: (id: number, sessionId: string) => boolean;
  /** Queue instructions for the worker's next step. */
  addSteers: (id: number, steers: readonly WorkflowSteer[]) => void;
  /** Drop the first `count` steers - the ones a worker step has just been given. */
  dropSteers: (id: number, count: number) => void;
  /** Keep a worker reply for the front's digest (only the last few are kept). */
  recordWorkerReply: (id: number, text: string, at: number) => void;
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
    "UPDATE workflows SET status = 'stopped', continue_as = NULL, steers = '[]', updated_at = $at WHERE id = $id AND status = 'active'",
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
  const resetAutoStmt = db.query("UPDATE workflows SET auto_turns = 0 WHERE id = $id");
  const frontStmt = db.query(
    "UPDATE workflows SET front_session_id = $sid WHERE id = $id AND front_session_id IS NULL",
  );
  const steersStmt = db.query("UPDATE workflows SET steers = $steers WHERE id = $id");
  const repliesStmt = db.query("UPDATE workflows SET worker_replies = $replies WHERE id = $id");
  const readRow = (id: number): Workflow | undefined => {
    const row = getStmt.get(id);
    return row ? toWorkflow(row) : undefined;
  };
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
    get: readRow,
    requestContinue: (id, slackId, at) =>
      requestStmt.get({ $id: id, $as: slackId, $at: at })?.continue_seq ?? undefined,
    takeContinue: (id, seq, at) => Number(takeStmt.run({ $id: id, $seq: seq, $at: at }).changes) > 0,
    clearContinue: (id) => {
      clearStmt.run({ $id: id });
    },
    resetAutoTurns: (id) => {
      resetAutoStmt.run({ $id: id });
    },
    setFrontSession: (id, sessionId) => Number(frontStmt.run({ $id: id, $sid: sessionId }).changes) > 0,
    // Read-modify-write is safe: bun:sqlite is synchronous, so nothing runs in between.
    addSteers: (id, steers) => {
      const w = readRow(id);
      if (!w || steers.length === 0) return;
      steersStmt.run({ $id: id, $steers: JSON.stringify([...w.steers, ...steers]) });
    },
    dropSteers: (id, count) => {
      const w = readRow(id);
      if (!w || count <= 0) return;
      steersStmt.run({ $id: id, $steers: JSON.stringify(w.steers.slice(count)) });
    },
    recordWorkerReply: (id, text, at) => {
      const w = readRow(id);
      if (!w || !text.trim()) return;
      repliesStmt.run({ $id: id, $replies: JSON.stringify(keepReplies(w.workerReplies, { text, at })) });
    },
  };
};
