/**
 * Access requests - people the bot does not know yet, waiting on the owner.
 *
 * A request is created the first time a stranger speaks and stays open until
 * the owner reacts on the notice they were sent. Keeping it in the database
 * (rather than in memory) means a restart does not strand someone mid-request,
 * and the owner's reaction still finds them.
 */
import type { DbClient } from "./client.ts";
import type { AccessRequest } from "../../domain/types.ts";

type Row = {
  id: number;
  slack_user_id: string;
  display_name: string;
  channel_id: string;
  thread_ts: string;
  asked: string;
  notice_channel: string;
  notice_ts: string;
  status: string;
  created_at: number;
  decided_at: number | null;
};

const toRequest = (row: Row): AccessRequest => ({
  id: row.id,
  slackUserId: row.slack_user_id,
  displayName: row.display_name,
  channelId: row.channel_id,
  threadTs: row.thread_ts,
  asked: row.asked,
  noticeChannel: row.notice_channel,
  noticeTs: row.notice_ts,
  status: row.status === "pending" ? "pending" : row.status === "approved" ? "approved" : "rejected",
  createdAt: row.created_at,
  decidedAt: row.decided_at ?? undefined,
});

export type NewAccessRequest = {
  slackUserId: string;
  displayName: string;
  channelId: string;
  threadTs: string;
  asked: string;
};

export type AccessRequestRepo = {
  open: (req: NewAccessRequest, at: number) => AccessRequest;
  /** The request this person already has waiting, if any. */
  pendingFor: (slackUserId: string) => AccessRequest | undefined;
  /** The request whose notice is this message - how a reaction is resolved. */
  byNotice: (channel: string, ts: string) => AccessRequest | undefined;
  /**
   * Remember one place the request was raised. There may be several: the owner
   * and every admin can decide, and each of them has to be able to see it.
   */
  addNotice: (id: number, channel: string, ts: string) => void;
  /** Every notice raised for a request, so all of them can be settled. */
  noticesFor: (id: number) => { channel: string; ts: string }[];
  /** Close it. False when it was already decided (a second reaction, say). */
  decide: (id: number, status: "approved" | "rejected", at: number) => boolean;
  listPending: () => AccessRequest[];
};

export const createAccessRequestRepo = (db: DbClient): AccessRequestRepo => {
  const insertStmt = db.query(
    `INSERT INTO access_requests (slack_user_id, display_name, channel_id, thread_ts, asked, status, created_at)
     VALUES ($slackUserId, $displayName, $channelId, $threadTs, $asked, 'pending', $at)
     RETURNING *`,
  );
  const pendingStmt = db.query<Row, [string]>(
    "SELECT * FROM access_requests WHERE slack_user_id = ? AND status = 'pending'",
  );
  const noticeStmt = db.query<Row, [string, string]>(
    `SELECT r.* FROM access_requests r
     JOIN access_request_notices n ON n.request_id = r.id
     WHERE n.channel = ? AND n.ts = ?`,
  );
  const addNoticeStmt = db.query(
    "INSERT OR IGNORE INTO access_request_notices (request_id, channel, ts) VALUES ($id, $channel, $ts)",
  );
  const noticesStmt = db.query<{ channel: string; ts: string }, [number]>(
    "SELECT channel, ts FROM access_request_notices WHERE request_id = ?",
  );
  const decideStmt = db.query(
    "UPDATE access_requests SET status = $status, decided_at = $at WHERE id = $id AND status = 'pending'",
  );
  const listStmt = db.query<Row, []>("SELECT * FROM access_requests WHERE status = 'pending' ORDER BY id DESC");

  return {
    open: (req, at) =>
      toRequest(
        insertStmt.get({
          $slackUserId: req.slackUserId,
          $displayName: req.displayName,
          $channelId: req.channelId,
          $threadTs: req.threadTs,
          $asked: req.asked,
          $at: at,
        }) as Row,
      ),
    pendingFor: (slackUserId) => {
      const row = pendingStmt.get(slackUserId);
      return row ? toRequest(row) : undefined;
    },
    byNotice: (channel, ts) => {
      const row = noticeStmt.get(channel, ts);
      return row ? toRequest(row) : undefined;
    },
    addNotice: (id, channel, ts) => {
      addNoticeStmt.run({ $id: id, $channel: channel, $ts: ts });
    },
    noticesFor: (id) => noticesStmt.all(id),
    decide: (id, status, at) => Number(decideStmt.run({ $id: id, $status: status, $at: at }).changes) > 0,
    listPending: () => listStmt.all().map(toRequest),
  };
};
