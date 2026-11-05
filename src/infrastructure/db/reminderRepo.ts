/**
 * Reminders people asked for.
 *
 * Durable for the same reason a watch is: a reminder that vanished on a
 * restart is a promise broken where nobody can see it break.
 */
import type { DbClient } from "./client.ts";
import type { ReminderState } from "../../domain/reminder.ts";

export type Reminder = {
  readonly id: number;
  readonly channelId: string;
  /** Empty when it was set outside a thread, so it posts in the channel. */
  readonly threadTs: string;
  readonly createdBy: string;
  readonly targets: readonly string[];
  readonly text: string;
  readonly dueAt: number;
  readonly state: ReminderState;
  readonly attempts: number;
  readonly lastError: string;
  readonly createdAt: number;
};

export type NewReminder = Pick<Reminder, "channelId" | "threadTs" | "createdBy" | "targets" | "text" | "dueAt">;

type Row = {
  id: number;
  channel_id: string;
  thread_ts: string;
  created_by: string;
  targets: string;
  text: string;
  due_at: number;
  state: string;
  attempts: number;
  last_error: string;
  created_at: number;
};

const STATES: readonly string[] = ["waiting", "sent", "cancelled", "failed"];
const asState = (v: string): ReminderState => (STATES.includes(v) ? (v as ReminderState) : "waiting");

const toReminder = (r: Row): Reminder => ({
  id: r.id,
  channelId: r.channel_id,
  threadTs: r.thread_ts,
  createdBy: r.created_by,
  targets: r.targets.split(",").filter(Boolean),
  text: r.text,
  dueAt: r.due_at,
  state: asState(r.state),
  attempts: r.attempts,
  lastError: r.last_error,
  createdAt: r.created_at,
});

export type ReminderRepo = {
  add: (r: NewReminder, at: number) => Reminder;
  /** Waiting reminders whose time has come, oldest first. */
  due: (now: number, limit?: number) => Reminder[];
  /** Still waiting, soonest first. */
  waiting: (limit?: number) => Reminder[];
  /** Still waiting and set by, or aimed at, this person. */
  waitingFor: (slackUserId: string, limit?: number) => Reminder[];
  get: (id: number) => Reminder | undefined;
  /** Try again later after a failed post, counting the attempt. */
  retry: (id: number, dueAt: number, at: number, error: string) => void;
  settle: (id: number, state: ReminderState, at: number, error?: string) => void;
};

export const createReminderRepo = (db: DbClient): ReminderRepo => {
  const insertStmt = db.query(
    `INSERT INTO reminders
       (channel_id, thread_ts, created_by, targets, text, due_at, state, attempts, last_error, created_at, updated_at)
     VALUES ($channelId, $threadTs, $createdBy, $targets, $text, $dueAt, 'waiting', 0, '', $at, $at)
     RETURNING *`,
  );
  const dueStmt = db.query<Row, [number, number]>(
    "SELECT * FROM reminders WHERE state = 'waiting' AND due_at <= ? ORDER BY due_at ASC LIMIT ?",
  );
  const waitingStmt = db.query<Row, [number]>(
    "SELECT * FROM reminders WHERE state = 'waiting' ORDER BY due_at ASC LIMIT ?",
  );
  const waitingForStmt = db.query<Row, [string, string, number]>(
    `SELECT * FROM reminders WHERE state = 'waiting'
       AND (created_by = ? OR (',' || targets || ',') LIKE ?)
     ORDER BY due_at ASC LIMIT ?`,
  );
  const getStmt = db.query<Row, [number]>("SELECT * FROM reminders WHERE id = ?");
  const retryStmt = db.query(
    `UPDATE reminders SET due_at = $dueAt, attempts = attempts + 1, last_error = $error, updated_at = $at
     WHERE id = $id`,
  );
  const settleStmt = db.query(
    "UPDATE reminders SET state = $state, updated_at = $at, last_error = COALESCE($error, last_error) WHERE id = $id",
  );

  return {
    add: (r, at) =>
      toReminder(
        insertStmt.get({
          $channelId: r.channelId,
          $threadTs: r.threadTs,
          $createdBy: r.createdBy,
          $targets: r.targets.join(","),
          $text: r.text.slice(0, 2000),
          $dueAt: r.dueAt,
          $at: at,
        }) as Row,
      ),
    due: (now, limit = 20) => dueStmt.all(now, Math.max(1, limit)).map(toReminder),
    waiting: (limit = 50) => waitingStmt.all(Math.max(1, limit)).map(toReminder),
    waitingFor: (id, limit = 20) => waitingForStmt.all(id, `%,${id},%`, Math.max(1, limit)).map(toReminder),
    get: (id) => {
      const r = getStmt.get(id);
      return r ? toReminder(r) : undefined;
    },
    retry: (id, dueAt, at, error) =>
      void retryStmt.run({ $id: id, $dueAt: dueAt, $at: at, $error: error.slice(0, 300) }),
    settle: (id, state, at, error) =>
      void settleStmt.run({ $id: id, $state: state, $at: at, $error: error?.slice(0, 300) ?? null }),
  };
};
