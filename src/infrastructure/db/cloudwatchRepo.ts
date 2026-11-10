/**
 * CloudWatch Logs Insights requests (`cloudwatch_requests`).
 *
 * A row is the parked Confirm / Cancel state while it is `pending` and the audit
 * record afterwards: who asked, the query and range, who confirmed it, what the
 * scan cost. It is a table rather than memory so a restart does not strand a
 * message someone is looking at - a press after one still resolves, or says the
 * request ran out.
 */
import type { DbClient } from "./client.ts";
import type { CloudwatchRequest } from "../../domain/cloudwatch.ts";
import type { UserRole } from "../../domain/types.ts";

export type CloudwatchStatus = "pending" | "running" | "done" | "failed" | "cancelled" | "expired";

export type StoredCloudwatch = {
  id: number;
  requestedBy: string;
  requesterRole: UserRole;
  channelId: string;
  threadTs: string;
  /** `run`: the owner, no confirmation. `confirm`: parked until a press. */
  mode: "run" | "confirm";
  request: CloudwatchRequest;
  estimateBytes: number;
  costly: boolean;
  status: CloudwatchStatus;
  confirmedBy?: string;
  noticeChannel: string;
  noticeTs: string;
  scannedBytes?: number;
  recordsMatched?: number;
  error: string;
  createdAt: number;
  decidedAt?: number;
  finishedAt?: number;
};

type Row = {
  id: number;
  requested_by: string;
  requester_role: string;
  channel_id: string;
  thread_ts: string;
  mode: string;
  region: string;
  log_groups: string;
  query: string;
  start_ms: number;
  end_ms: number;
  row_limit: number;
  estimate_bytes: number;
  costly: number;
  status: string;
  confirmed_by: string;
  notice_channel: string;
  notice_ts: string;
  scanned_bytes: number | null;
  records_matched: number | null;
  error: string;
  created_at: number;
  decided_at: number | null;
  finished_at: number | null;
};

const STATUSES: readonly CloudwatchStatus[] = ["pending", "running", "done", "failed", "cancelled", "expired"];

const parseGroups = (raw: string): string[] => {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((g): g is string => typeof g === "string") : [];
  } catch {
    return [];
  }
};

const toStored = (row: Row): StoredCloudwatch => ({
  id: row.id,
  requestedBy: row.requested_by,
  requesterRole: row.requester_role as UserRole,
  channelId: row.channel_id,
  threadTs: row.thread_ts,
  mode: row.mode === "run" ? "run" : "confirm",
  request: {
    groups: parseGroups(row.log_groups),
    region: row.region,
    query: row.query,
    startMs: row.start_ms,
    endMs: row.end_ms,
    limit: row.row_limit,
  },
  estimateBytes: row.estimate_bytes,
  costly: row.costly === 1,
  status: STATUSES.find((s) => s === row.status) ?? "failed",
  confirmedBy: row.confirmed_by || undefined,
  noticeChannel: row.notice_channel,
  noticeTs: row.notice_ts,
  scannedBytes: row.scanned_bytes ?? undefined,
  recordsMatched: row.records_matched ?? undefined,
  error: row.error,
  createdAt: row.created_at,
  decidedAt: row.decided_at ?? undefined,
  finishedAt: row.finished_at ?? undefined,
});

export type NewCloudwatch = {
  requestedBy: string;
  requesterRole: UserRole;
  channelId: string;
  threadTs: string;
  mode: "run" | "confirm";
  request: CloudwatchRequest;
  estimateBytes: number;
  costly: boolean;
};

export type CloudwatchRepo = {
  /** Park (`confirm`) or record a direct run (`run`, already running, confirmed by the requester). */
  open: (req: NewCloudwatch, at: number) => StoredCloudwatch;
  get: (id: number) => StoredCloudwatch | undefined;
  setNotice: (id: number, channel: string, ts: string) => void;
  /** pending -> running, only while it is still pending and younger than `ttlMs`. False otherwise. */
  claim: (id: number, by: string, at: number, ttlMs: number) => boolean;
  /** pending -> cancelled. False when it was already decided. */
  cancel: (id: number, by: string, at: number) => boolean;
  /** pending -> expired when older than `ttlMs`. False when it is not pending or not old enough. */
  expire: (id: number, at: number, ttlMs: number) => boolean;
  finish: (id: number, result: { ok: true; scannedBytes: number; recordsMatched: number } | { ok: false; error: string }, at: number) => void;
  /** Most recent first, for the audit view. */
  recent: (limit: number) => StoredCloudwatch[];
};

export const createCloudwatchRepo = (db: DbClient): CloudwatchRepo => {
  const insertStmt = db.query(
    `INSERT INTO cloudwatch_requests
       (requested_by, requester_role, channel_id, thread_ts, mode, region, log_groups, query, start_ms, end_ms,
        row_limit, estimate_bytes, costly, status, confirmed_by, created_at, decided_at)
     VALUES ($by, $role, $channel, $thread, $mode, $region, $groups, $query, $start, $end,
        $limit, $estimate, $costly, $status, $confirmedBy, $at, $decidedAt)
     RETURNING *`,
  );
  const getStmt = db.query<Row, [number]>("SELECT * FROM cloudwatch_requests WHERE id = ?");
  const noticeStmt = db.query("UPDATE cloudwatch_requests SET notice_channel = $channel, notice_ts = $ts WHERE id = $id");
  const claimStmt = db.query(
    `UPDATE cloudwatch_requests SET status = 'running', confirmed_by = $by, decided_at = $at
     WHERE id = $id AND status = 'pending' AND created_at >= $oldest`,
  );
  const cancelStmt = db.query(
    `UPDATE cloudwatch_requests SET status = 'cancelled', confirmed_by = '', decided_at = $at, error = $by
     WHERE id = $id AND status = 'pending'`,
  );
  const expireStmt = db.query(
    `UPDATE cloudwatch_requests SET status = 'expired', decided_at = $at
     WHERE id = $id AND status = 'pending' AND created_at < $oldest`,
  );
  const doneStmt = db.query(
    `UPDATE cloudwatch_requests SET status = 'done', scanned_bytes = $scanned, records_matched = $matched, finished_at = $at
     WHERE id = $id`,
  );
  const failStmt = db.query("UPDATE cloudwatch_requests SET status = 'failed', error = $error, finished_at = $at WHERE id = $id");
  const recentStmt = db.query<Row, [number]>("SELECT * FROM cloudwatch_requests ORDER BY id DESC LIMIT ?");

  return {
    open: (req, at) =>
      toStored(
        insertStmt.get({
          $by: req.requestedBy,
          $role: req.requesterRole,
          $channel: req.channelId,
          $thread: req.threadTs,
          $mode: req.mode,
          $region: req.request.region,
          $groups: JSON.stringify(req.request.groups),
          $query: req.request.query,
          $start: req.request.startMs,
          $end: req.request.endMs,
          $limit: req.request.limit,
          $estimate: req.estimateBytes,
          $costly: req.costly ? 1 : 0,
          $status: req.mode === "run" ? "running" : "pending",
          $confirmedBy: req.mode === "run" ? req.requestedBy : "",
          $at: at,
          $decidedAt: req.mode === "run" ? at : null,
        }) as Row,
      ),
    get: (id) => {
      const row = getStmt.get(id);
      return row ? toStored(row) : undefined;
    },
    setNotice: (id, channel, ts) => {
      noticeStmt.run({ $id: id, $channel: channel, $ts: ts });
    },
    claim: (id, by, at, ttlMs) => Number(claimStmt.run({ $id: id, $by: by, $at: at, $oldest: at - ttlMs }).changes) > 0,
    cancel: (id, by, at) => Number(cancelStmt.run({ $id: id, $by: by, $at: at }).changes) > 0,
    expire: (id, at, ttlMs) => Number(expireStmt.run({ $id: id, $at: at, $oldest: at - ttlMs }).changes) > 0,
    finish: (id, result, at) => {
      if (result.ok) doneStmt.run({ $id: id, $scanned: result.scannedBytes, $matched: result.recordsMatched, $at: at });
      else failStmt.run({ $id: id, $error: result.error.slice(0, 500), $at: at });
    },
    recent: (limit) => recentStmt.all(limit).map(toStored),
  };
};
