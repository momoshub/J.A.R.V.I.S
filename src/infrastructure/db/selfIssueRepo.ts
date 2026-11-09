/**
 * Defects the inner child found in the bot itself, and how each fix went.
 */
import type { DbClient } from "./client.ts";
import type { Finding, Severity } from "../../domain/innerChild.ts";

/**
 * `stale` is an issue closed unfixed by `pruneStale`: it sat queued past the
 * age limit. The row stays (its fingerprint still dedupes), only the state says why.
 */
export type SelfIssueState = "queued" | "fixing" | "fixed" | "not_fixed" | "failed" | "stale";

export type SelfIssue = {
  readonly id: number;
  readonly fingerprint: string;
  readonly title: string;
  readonly severity: Severity;
  readonly evidence: string;
  readonly sourceChannel: string;
  readonly sourceThread: string;
  readonly fixChannel: string;
  readonly fixThread: string;
  readonly state: SelfIssueState;
  readonly startedAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

type Row = {
  id: number;
  fingerprint: string;
  title: string;
  severity: string;
  evidence: string;
  source_channel: string;
  source_thread: string;
  fix_channel: string;
  fix_thread: string;
  state: string;
  started_at: number;
  created_at: number;
  updated_at: number;
};

const asState = (v: string): SelfIssueState =>
  v === "fixing" || v === "fixed" || v === "not_fixed" || v === "failed" || v === "stale" ? v : "queued";

const toIssue = (r: Row): SelfIssue => ({
  id: r.id,
  fingerprint: r.fingerprint,
  title: r.title,
  severity: r.severity === "critical" ? "critical" : "bug",
  evidence: r.evidence,
  sourceChannel: r.source_channel,
  sourceThread: r.source_thread,
  fixChannel: r.fix_channel,
  fixThread: r.fix_thread,
  state: asState(r.state),
  startedAt: r.started_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type SelfIssueRepo = {
  /** File a finding as queued. undefined when its fingerprint is already on file. */
  file: (f: Finding, now: number) => SelfIssue | undefined;
  /** The queued issue to fix next: critical first, then oldest. */
  nextQueued: () => SelfIssue | undefined;
  /** Mark an issue as being fixed, in the thread the fix runs in. */
  startFix: (id: number, channel: string, threadTs: string, now: number) => void;
  settle: (id: number, state: SelfIssueState, now: number) => void;
  /** Issues whose fix is running. */
  fixing: () => SelfIssue[];
  /** How many fixes started since `since`, for the daily cap. */
  startedSince: (since: number) => number;
  /** Issues still open: queued or being fixed. What the open cap counts. */
  openCount: () => number;
  /**
   * Close queued issues whose last activity is before `before` as `stale`,
   * newest state change = `now`. Never touches one being fixed. Returns them.
   */
  pruneStale: (before: number, now: number) => SelfIssue[];
  /** The newest issues, so the triage is told what is already known. */
  recentTitles: (limit: number) => string[];
  /** Threads the inner child runs fixes in, so it never triages its own work. */
  isFixThread: (channel: string, threadTs: string) => boolean;
  get: (id: number) => SelfIssue | undefined;
};

export const createSelfIssueRepo = (db: DbClient): SelfIssueRepo => {
  const insert = db.query<Row, [string, string, string, string, string, string, number, number]>(
    `INSERT OR IGNORE INTO self_issues
       (fingerprint, title, severity, evidence, source_channel, source_thread, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  );
  const nextStmt = db.query<Row, []>(
    `SELECT * FROM self_issues WHERE state = 'queued'
      ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, id LIMIT 1`,
  );
  const startStmt = db.query(
    "UPDATE self_issues SET state = 'fixing', fix_channel = ?, fix_thread = ?, started_at = ?, updated_at = ? WHERE id = ?",
  );
  const settleStmt = db.query("UPDATE self_issues SET state = ?, updated_at = ? WHERE id = ?");
  const fixingStmt = db.query<Row, []>("SELECT * FROM self_issues WHERE state = 'fixing' ORDER BY id");
  const sinceStmt = db.query<{ n: number }, [number]>(
    "SELECT COUNT(*) AS n FROM self_issues WHERE started_at > 0 AND started_at >= ?",
  );
  const openStmt = db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM self_issues WHERE state IN ('queued', 'fixing')",
  );
  const pruneStmt = db.query<Row, [number, number]>(
    `UPDATE self_issues SET state = 'stale', updated_at = ?
      WHERE state = 'queued' AND updated_at < ? RETURNING *`,
  );
  const titlesStmt = db.query<{ title: string; fingerprint: string }, [number]>(
    "SELECT title, fingerprint FROM self_issues ORDER BY id DESC LIMIT ?",
  );
  const fixThreadStmt = db.query<{ n: number }, [string, string]>(
    "SELECT COUNT(*) AS n FROM self_issues WHERE fix_channel = ? AND fix_thread = ?",
  );
  const getStmt = db.query<Row, [number]>("SELECT * FROM self_issues WHERE id = ?");

  return {
    file: (f, now) => {
      // The hint rides with the evidence: the fix run reads both, nothing else does.
      const evidence = f.hint ? `${f.evidence}\nhint: ${f.hint}` : f.evidence;
      const r = insert.get(f.fingerprint, f.title, f.severity, evidence, f.channelId, f.threadTs, now, now);
      return r ? toIssue(r) : undefined;
    },
    nextQueued: () => {
      const r = nextStmt.get();
      return r ? toIssue(r) : undefined;
    },
    startFix: (id, channel, threadTs, now) => void startStmt.run(channel, threadTs, now, now, id),
    settle: (id, state, now) => void settleStmt.run(state, now, id),
    fixing: () => fixingStmt.all().map(toIssue),
    startedSince: (since) => sinceStmt.get(since)?.n ?? 0,
    openCount: () => openStmt.get()?.n ?? 0,
    pruneStale: (before, now) => pruneStmt.all(now, before).map(toIssue),
    recentTitles: (limit) => titlesStmt.all(Math.max(1, limit)).map((r) => `${r.fingerprint}: ${r.title}`),
    isFixThread: (channel, threadTs) => !!threadTs && (fixThreadStmt.get(channel, threadTs)?.n ?? 0) > 0,
    get: (id) => {
      const r = getStmt.get(id);
      return r ? toIssue(r) : undefined;
    },
  };
};
