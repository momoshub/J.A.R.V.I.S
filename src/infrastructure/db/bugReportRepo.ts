/** Bug reports the bot raised about itself, and where the owner stands on each. See domain/bugReport.ts. */
import type { DbClient } from "./client.ts";
import type { BugReportState } from "../../domain/bugReport.ts";

export type BugReport = {
  readonly id: number;
  readonly fingerprint: string;
  readonly threadLink: string;
  readonly issue: string;
  readonly summary: string;
  readonly plan: string;
  readonly state: BugReportState;
  /** The channel of the turn that spotted it. */
  readonly reportedIn: string;
  /** The owner's DM the question was posted in; empty until it went out. */
  readonly noticeChannel: string;
  readonly noticeTs: string;
  readonly createdAt: number;
  readonly decidedAt: number;
};

export type NewBugReport = Pick<BugReport, "fingerprint" | "threadLink" | "issue" | "summary" | "plan" | "reportedIn">;

type Row = {
  id: number;
  fingerprint: string;
  thread_link: string;
  issue: string;
  summary: string;
  plan: string;
  state: string;
  reported_in: string;
  notice_channel: string;
  notice_ts: string;
  created_at: number;
  decided_at: number;
};

const toReport = (r: Row): BugReport => ({
  id: r.id,
  fingerprint: r.fingerprint,
  threadLink: r.thread_link,
  issue: r.issue,
  summary: r.summary,
  plan: r.plan,
  state: r.state === "approved" || r.state === "rejected" ? r.state : "pending",
  reportedIn: r.reported_in,
  noticeChannel: r.notice_channel,
  noticeTs: r.notice_ts,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

export type BugReportRepo = {
  add: (b: NewBugReport, at: number) => BugReport;
  get: (id: number) => BugReport | undefined;
  /** The newest report with this fingerprint filed at or after `since`, whatever its state. */
  recent: (fingerprint: string, since: number) => BugReport | undefined;
  /** The newest reports in this state, newest first. */
  byState: (state: BugReportState, limit: number) => BugReport[];
  /** How many reports were filed at or after `since`. */
  countSince: (since: number) => number;
  setNotice: (id: number, channel: string, ts: string) => void;
  /** Pending -> approved or rejected; false when it was not pending (so a second press changes nothing). */
  decide: (id: number, state: "approved" | "rejected", at: number) => boolean;
  /** Drop a report whose question never went out. */
  discard: (id: number) => void;
};

export const createBugReportRepo = (db: DbClient): BugReportRepo => {
  const insertStmt = db.query<Row, Record<string, string | number>>(
    `INSERT INTO bug_reports (fingerprint, thread_link, issue, summary, plan, reported_in, created_at)
     VALUES ($fingerprint, $threadLink, $issue, $summary, $plan, $reportedIn, $at)
     RETURNING *`,
  );
  const getStmt = db.query<Row, [number]>("SELECT * FROM bug_reports WHERE id = ?");
  const recentStmt = db.query<Row, [string, number]>(
    "SELECT * FROM bug_reports WHERE fingerprint = ? AND created_at >= ? ORDER BY id DESC LIMIT 1",
  );
  const stateStmt = db.query<Row, [string, number]>("SELECT * FROM bug_reports WHERE state = ? ORDER BY id DESC LIMIT ?");
  const countStmt = db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM bug_reports WHERE created_at >= ?");
  const noticeStmt = db.query("UPDATE bug_reports SET notice_channel = ?, notice_ts = ? WHERE id = ?");
  const decideStmt = db.query("UPDATE bug_reports SET state = ?, decided_at = ? WHERE id = ? AND state = 'pending'");
  const discardStmt = db.query("DELETE FROM bug_reports WHERE id = ?");

  return {
    add: (b, at) => {
      const row = insertStmt.get({
        $fingerprint: b.fingerprint,
        $threadLink: b.threadLink,
        $issue: b.issue,
        $summary: b.summary,
        $plan: b.plan,
        $reportedIn: b.reportedIn,
        $at: at,
      });
      if (!row) throw new Error("bug report insert returned no row");
      return toReport(row);
    },
    get: (id) => {
      const row = getStmt.get(id);
      return row ? toReport(row) : undefined;
    },
    recent: (fingerprint, since) => {
      const row = recentStmt.get(fingerprint, since);
      return row ? toReport(row) : undefined;
    },
    byState: (state, limit) => stateStmt.all(state, Math.max(1, limit)).map(toReport),
    countSince: (since) => countStmt.get(since)?.n ?? 0,
    setNotice: (id, channel, ts) => void noticeStmt.run(channel, ts, id),
    decide: (id, state, at) => decideStmt.run(state, at, id).changes > 0,
    discard: (id) => void discardStmt.run(id),
  };
};
