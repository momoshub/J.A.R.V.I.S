/**
 * Is a Slack message one of the bot's approval notices?
 *
 * Every flow that asks the owner (or someone else) to press a button stores the
 * message it posted as `notice_channel` + `notice_ts` on its own row: learnings,
 * loops, command approvals, access requests, CloudWatch requests and bug reports. One query
 * over all six answers "is this ts a notice" from the database alone, so the
 * Slack proxy can refuse to let a turn rewrite one without reading the message
 * back from Slack on every call.
 */
import type { DbClient } from "./client.ts";

const TABLES = ["learnings", "loops", "command_approvals", "access_requests", "cloudwatch_requests", "bug_reports"] as const;

export const createNoticeLookup = (db: DbClient): ((channel: string, ts: string) => boolean) => {
  const stmt = db.query<{ found: number }, { $channel: string; $ts: string }>(
    TABLES.map((t) => `SELECT 1 AS found FROM ${t} WHERE notice_channel = $channel AND notice_ts = $ts`).join(" UNION ALL ") + " LIMIT 1",
  );
  return (channel, ts) => !!channel && !!ts && stmt.get({ $channel: channel, $ts: ts }) != null;
};
