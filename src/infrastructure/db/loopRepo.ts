/**
 * Recurring loops people asked for.
 *
 * Durable in the same store as reminders and watches: a loop that vanished on
 * a restart is a schedule that silently stopped.
 */
import type { DbClient } from "./client.ts";
import type { LoopState } from "../../domain/loop.ts";

export type Loop = {
  readonly id: number;
  readonly channelId: string;
  readonly threadTs: string;
  readonly createdBy: string;
  /** Canonical text, e.g. `every monday at 09:00`. */
  readonly schedule: string;
  readonly prompt: string;
  /** Script mode: a shell command run with no turn. Empty for a prompt loop. */
  readonly command: string;
  readonly nextAt: number;
  readonly lastRunAt: number | undefined;
  readonly runs: number;
  readonly state: LoopState;
  readonly lastError: string;
  readonly createdAt: number;
};

export type NewLoop = Pick<Loop, "channelId" | "threadTs" | "createdBy" | "schedule" | "prompt" | "command" | "nextAt">;

type Row = {
  id: number;
  channel_id: string;
  thread_ts: string;
  created_by: string;
  schedule: string;
  prompt: string;
  command: string;
  next_at: number;
  last_run_at: number | null;
  runs: number;
  state: string;
  last_error: string;
  created_at: number;
};

const STATES: readonly string[] = ["active", "cancelled", "failed"];
const asState = (v: string): LoopState => (STATES.includes(v) ? (v as LoopState) : "active");

const toLoop = (r: Row): Loop => ({
  id: r.id,
  channelId: r.channel_id,
  threadTs: r.thread_ts,
  createdBy: r.created_by,
  schedule: r.schedule,
  prompt: r.prompt,
  command: r.command,
  nextAt: r.next_at,
  lastRunAt: r.last_run_at ?? undefined,
  runs: r.runs,
  state: asState(r.state),
  lastError: r.last_error,
  createdAt: r.created_at,
});

export type LoopRepo = {
  add: (l: NewLoop, at: number) => Loop;
  /** Active loops whose time has come, oldest first. */
  due: (now: number, limit?: number) => Loop[];
  /** Active, soonest first. */
  active: (limit?: number) => Loop[];
  activeBy: (slackUserId: string, limit?: number) => Loop[];
  get: (id: number) => Loop | undefined;
  /** Record a fire: count it and move the next one on. */
  fired: (id: number, nextAt: number, at: number) => void;
  /** Move the next fire without counting a run (a failed start). */
  reschedule: (id: number, nextAt: number, at: number, error?: string) => void;
  settle: (id: number, state: LoopState, at: number, error?: string) => void;
};

export const createLoopRepo = (db: DbClient): LoopRepo => {
  const insertStmt = db.query(
    `INSERT INTO loops (channel_id, thread_ts, created_by, schedule, prompt, command, next_at, state, created_at, updated_at)
     VALUES ($channelId, $threadTs, $createdBy, $schedule, $prompt, $command, $nextAt, 'active', $at, $at)
     RETURNING *`,
  );
  const dueStmt = db.query<Row, [number, number]>(
    "SELECT * FROM loops WHERE state = 'active' AND next_at <= ? ORDER BY next_at ASC LIMIT ?",
  );
  const activeStmt = db.query<Row, [number]>("SELECT * FROM loops WHERE state = 'active' ORDER BY next_at ASC LIMIT ?");
  const byStmt = db.query<Row, [string, number]>(
    "SELECT * FROM loops WHERE state = 'active' AND created_by = ? ORDER BY next_at ASC LIMIT ?",
  );
  const getStmt = db.query<Row, [number]>("SELECT * FROM loops WHERE id = ?");
  const firedStmt = db.query(
    `UPDATE loops SET next_at = $nextAt, last_run_at = $at, runs = runs + 1, last_error = '', updated_at = $at
     WHERE id = $id`,
  );
  const rescheduleStmt = db.query(
    "UPDATE loops SET next_at = $nextAt, last_error = COALESCE($error, last_error), updated_at = $at WHERE id = $id",
  );
  const settleStmt = db.query(
    "UPDATE loops SET state = $state, updated_at = $at, last_error = COALESCE($error, last_error) WHERE id = $id",
  );

  return {
    add: (l, at) =>
      toLoop(
        insertStmt.get({
          $channelId: l.channelId,
          $threadTs: l.threadTs,
          $createdBy: l.createdBy,
          $schedule: l.schedule,
          $prompt: l.prompt.slice(0, 2000),
          $command: l.command.slice(0, 2000),
          $nextAt: l.nextAt,
          $at: at,
        }) as Row,
      ),
    due: (now, limit = 20) => dueStmt.all(now, Math.max(1, limit)).map(toLoop),
    active: (limit = 50) => activeStmt.all(Math.max(1, limit)).map(toLoop),
    activeBy: (id, limit = 20) => byStmt.all(id, Math.max(1, limit)).map(toLoop),
    get: (id) => {
      const r = getStmt.get(id);
      return r ? toLoop(r) : undefined;
    },
    fired: (id, nextAt, at) => void firedStmt.run({ $id: id, $nextAt: nextAt, $at: at }),
    reschedule: (id, nextAt, at, error) =>
      void rescheduleStmt.run({ $id: id, $nextAt: nextAt, $at: at, $error: error?.slice(0, 300) ?? null }),
    settle: (id, state, at, error) =>
      void settleStmt.run({ $id: id, $state: state, $at: at, $error: error?.slice(0, 300) ?? null }),
  };
};
