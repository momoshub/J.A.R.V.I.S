/**
 * Recurring loops people asked for.
 *
 * Durable in the same store as reminders and watches: a loop that vanished on
 * a restart is a schedule that silently stopped.
 */
import type { DbClient } from "./client.ts";
import { cleanName, deriveName, type LoopState } from "../../domain/loop.ts";

export type Loop = {
  readonly id: number;
  readonly channelId: string;
  readonly threadTs: string;
  readonly createdBy: string;
  /** What people call it; never empty (an unnamed row gets the first words of its prompt). */
  readonly name: string;
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
  /** Where the owner's Approve / Reject message sits, for a pending script loop. */
  readonly noticeChannel: string;
  readonly noticeTs: string;
  /** Ts of the message that created it (`threadTs` is the thread it sat in); empty when unknown, as for loops made before this was kept. */
  readonly originTs: string;
};

export type NewLoop = Pick<Loop, "channelId" | "threadTs" | "createdBy" | "schedule" | "prompt" | "command" | "nextAt"> & {
  /** Left out or blank: derived from the prompt (or the command). */
  readonly name?: string;
  /** The creating message's ts; left out when there was none (a slash command). */
  readonly originTs?: string;
  /** `pending` for a script loop awaiting approval; default `active`. */
  readonly state?: "pending" | "active";
};

type Row = {
  id: number;
  channel_id: string;
  thread_ts: string;
  created_by: string;
  name: string;
  schedule: string;
  prompt: string;
  command: string;
  next_at: number;
  last_run_at: number | null;
  runs: number;
  state: string;
  last_error: string;
  created_at: number;
  notice_channel: string;
  notice_ts: string;
  origin_ts: string;
};

const STATES: readonly string[] = ["pending", "active", "cancelled", "failed"];
const asState = (v: string): LoopState => (STATES.includes(v) ? (v as LoopState) : "active");

const toLoop = (r: Row): Loop => ({
  id: r.id,
  channelId: r.channel_id,
  threadTs: r.thread_ts,
  createdBy: r.created_by,
  name: r.name || deriveName(r.prompt, r.command),
  schedule: r.schedule,
  prompt: r.prompt,
  command: r.command,
  nextAt: r.next_at,
  lastRunAt: r.last_run_at ?? undefined,
  runs: r.runs,
  state: asState(r.state),
  lastError: r.last_error,
  createdAt: r.created_at,
  noticeChannel: r.notice_channel,
  noticeTs: r.notice_ts,
  originTs: r.origin_ts,
});

export type LoopRepo = {
  add: (l: NewLoop, at: number) => Loop;
  /** Active loops whose time has come, oldest first. */
  due: (now: number, limit?: number) => Loop[];
  /** Active, soonest first. */
  active: (limit?: number) => Loop[];
  activeBy: (slackUserId: string, limit?: number) => Loop[];
  /** Active and pending, soonest first: what `loop list` shows and the per-person cap counts. */
  liveBy: (slackUserId: string, limit?: number) => Loop[];
  /** Pending only, oldest first. */
  pending: (limit?: number) => Loop[];
  get: (id: number) => Loop | undefined;
  /** Record a fire: count it and move the next one on. */
  fired: (id: number, nextAt: number, at: number) => void;
  /** Give a live loop a new name. False when it is gone, not live, or the name is blank once cleaned. */
  rename: (id: number, name: string, at: number) => boolean;
  /** Move the next fire without counting a run (a failed start). */
  reschedule: (id: number, nextAt: number, at: number, error?: string) => void;
  settle: (id: number, state: LoopState, at: number, error?: string) => void;
  /** Remember the approval message, so it can be settled later. */
  setNotice: (id: number, channel: string, ts: string) => void;
  /** pending -> active with a first fire time. False when it was not pending (decided already, or gone). */
  activate: (id: number, nextAt: number, at: number) => boolean;
  /** Delete a loop that is still pending. False when it was not pending. */
  discard: (id: number) => boolean;
  /** Delete pending loops older than `ttlMs` and return them. */
  expirePending: (now: number, ttlMs: number) => Loop[];
};

export const createLoopRepo = (db: DbClient): LoopRepo => {
  const insertStmt = db.query(
    `INSERT INTO loops (channel_id, thread_ts, created_by, name, schedule, prompt, command, next_at, state, origin_ts, created_at, updated_at)
     VALUES ($channelId, $threadTs, $createdBy, $name, $schedule, $prompt, $command, $nextAt, $state, $originTs, $at, $at)
     RETURNING *`,
  );
  const dueStmt = db.query<Row, [number, number]>(
    "SELECT * FROM loops WHERE state = 'active' AND next_at <= ? ORDER BY next_at ASC LIMIT ?",
  );
  const activeStmt = db.query<Row, [number]>("SELECT * FROM loops WHERE state = 'active' ORDER BY next_at ASC LIMIT ?");
  const byStmt = db.query<Row, [string, number]>(
    "SELECT * FROM loops WHERE state = 'active' AND created_by = ? ORDER BY next_at ASC LIMIT ?",
  );
  const liveStmt = db.query<Row, [string, number]>(
    "SELECT * FROM loops WHERE state IN ('active', 'pending') AND created_by = ? ORDER BY next_at ASC LIMIT ?",
  );
  const pendingStmt = db.query<Row, [number]>("SELECT * FROM loops WHERE state = 'pending' ORDER BY created_at ASC LIMIT ?");
  const noticeStmt = db.query("UPDATE loops SET notice_channel = $channel, notice_ts = $ts WHERE id = $id");
  const activateStmt = db.query(
    "UPDATE loops SET state = 'active', next_at = $nextAt, updated_at = $at WHERE id = $id AND state = 'pending'",
  );
  const discardStmt = db.query("DELETE FROM loops WHERE id = $id AND state = 'pending'");
  const getStmt = db.query<Row, [number]>("SELECT * FROM loops WHERE id = ?");
  const firedStmt = db.query(
    `UPDATE loops SET next_at = $nextAt, last_run_at = $at, runs = runs + 1, last_error = '', updated_at = $at
     WHERE id = $id`,
  );
  const rescheduleStmt = db.query(
    "UPDATE loops SET next_at = $nextAt, last_error = COALESCE($error, last_error), updated_at = $at WHERE id = $id",
  );
  const renameStmt = db.query(
    "UPDATE loops SET name = $name, updated_at = $at WHERE id = $id AND state IN ('active', 'pending')",
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
          $name: cleanName(l.name ?? "") || deriveName(l.prompt, l.command),
          $schedule: l.schedule,
          $prompt: l.prompt.slice(0, 2000),
          $command: l.command.slice(0, 2000),
          $nextAt: l.nextAt,
          $state: l.state ?? "active",
          $originTs: l.originTs ?? "",
          $at: at,
        }) as Row,
      ),
    due: (now, limit = 20) => dueStmt.all(now, Math.max(1, limit)).map(toLoop),
    active: (limit = 50) => activeStmt.all(Math.max(1, limit)).map(toLoop),
    activeBy: (id, limit = 20) => byStmt.all(id, Math.max(1, limit)).map(toLoop),
    liveBy: (id, limit = 20) => liveStmt.all(id, Math.max(1, limit)).map(toLoop),
    pending: (limit = 50) => pendingStmt.all(Math.max(1, limit)).map(toLoop),
    get: (id) => {
      const r = getStmt.get(id);
      return r ? toLoop(r) : undefined;
    },
    fired: (id, nextAt, at) => void firedStmt.run({ $id: id, $nextAt: nextAt, $at: at }),
    reschedule: (id, nextAt, at, error) =>
      void rescheduleStmt.run({ $id: id, $nextAt: nextAt, $at: at, $error: error?.slice(0, 300) ?? null }),
    rename: (id, name, at) => {
      const clean = cleanName(name);
      return clean !== "" && Number(renameStmt.run({ $id: id, $name: clean, $at: at }).changes) > 0;
    },
    settle: (id, state, at, error) =>
      void settleStmt.run({ $id: id, $state: state, $at: at, $error: error?.slice(0, 300) ?? null }),
    setNotice: (id, channel, ts) => void noticeStmt.run({ $id: id, $channel: channel, $ts: ts }),
    activate: (id, nextAt, at) => Number(activateStmt.run({ $id: id, $nextAt: nextAt, $at: at }).changes) > 0,
    discard: (id) => Number(discardStmt.run({ $id: id }).changes) > 0,
    expirePending: (now, ttlMs) =>
      pendingStmt
        .all(1000)
        .filter((r) => r.created_at <= now - ttlMs)
        .filter((r) => Number(discardStmt.run({ $id: r.id }).changes) > 0)
        .map(toLoop),
  };
};
