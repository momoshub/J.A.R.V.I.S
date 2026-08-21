/**
 * Commands parked for the owner's approval.
 *
 * A rate-limited role that runs out of allowance is not refused outright - the
 * command is kept here and someone with authority approves or rejects it. It is
 * a table rather than memory so a restart does not drop a request that someone
 * is waiting on, and so a click still resolves after one.
 */
import type { DbClient } from "./client.ts";
import type { CommandApproval } from "../../domain/types.ts";

type Row = {
  id: number;
  slack_user_id: string;
  display_name: string;
  channel_id: string;
  thread_ts: string;
  line: string;
  notice_channel: string;
  notice_ts: string;
  status: string;
  decided_by: string;
  created_at: number;
  decided_at: number | null;
};

const toApproval = (row: Row): CommandApproval => ({
  id: row.id,
  slackUserId: row.slack_user_id,
  displayName: row.display_name,
  channelId: row.channel_id,
  threadTs: row.thread_ts,
  line: row.line,
  noticeChannel: row.notice_channel,
  noticeTs: row.notice_ts,
  status: row.status === "pending" ? "pending" : row.status === "approved" ? "approved" : "rejected",
  decidedBy: row.decided_by || undefined,
  createdAt: row.created_at,
  decidedAt: row.decided_at ?? undefined,
});

export type NewCommandApproval = {
  slackUserId: string;
  displayName: string;
  channelId: string;
  threadTs: string;
  line: string;
};

export type CommandApprovalRepo = {
  open: (req: NewCommandApproval, at: number) => CommandApproval;
  get: (id: number) => CommandApproval | undefined;
  setNotice: (id: number, channel: string, ts: string) => void;
  /** Close it. False when it was already decided, so a second click does nothing. */
  decide: (id: number, status: "approved" | "rejected", by: string, at: number) => boolean;
  listPending: () => CommandApproval[];
};

export const createCommandApprovalRepo = (db: DbClient): CommandApprovalRepo => {
  const insertStmt = db.query(
    `INSERT INTO command_approvals (slack_user_id, display_name, channel_id, thread_ts, line, status, created_at)
     VALUES ($slackUserId, $displayName, $channelId, $threadTs, $line, 'pending', $at)
     RETURNING *`,
  );
  const getStmt = db.query<Row, [number]>("SELECT * FROM command_approvals WHERE id = ?");
  const noticeStmt = db.query(
    "UPDATE command_approvals SET notice_channel = $channel, notice_ts = $ts WHERE id = $id",
  );
  const decideStmt = db.query(
    `UPDATE command_approvals SET status = $status, decided_by = $by, decided_at = $at
     WHERE id = $id AND status = 'pending'`,
  );
  const listStmt = db.query<Row, []>("SELECT * FROM command_approvals WHERE status = 'pending' ORDER BY id DESC");

  return {
    open: (req, at) =>
      toApproval(
        insertStmt.get({
          $slackUserId: req.slackUserId,
          $displayName: req.displayName,
          $channelId: req.channelId,
          $threadTs: req.threadTs,
          $line: req.line,
          $at: at,
        }) as Row,
      ),
    get: (id) => {
      const row = getStmt.get(id);
      return row ? toApproval(row) : undefined;
    },
    setNotice: (id, channel, ts) => {
      noticeStmt.run({ $id: id, $channel: channel, $ts: ts });
    },
    decide: (id, status, by, at) =>
      Number(decideStmt.run({ $id: id, $status: status, $by: by, $at: at }).changes) > 0,
    listPending: () => listStmt.all().map(toApproval),
  };
};
