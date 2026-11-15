/**
 * Bug reports: the bot tells its owner about a bug in ITSELF.
 *
 * A chat turn can only post in the channel it runs in, so from someone else's
 * thread it could not reach the owner. The internal `bug-report` command (the
 * brain's own turn only) DMs the owner what broke, where, why and the plan to
 * fix it, with Approve / Reject. A press is decided in code by its own Slack
 * listener (application/bugReportApproval.ts), never by a model turn, and only
 * an approve starts the fix, in the notice's thread, as the owner.
 */
import { cleanLine, tokenize, unwrapLink } from "./journey.ts";

/** Buttons with this prefix are decided in code by their own listener, never a turn for the model. */
export const BUG_REPORT_ACTION_PREFIX = "jv:bug-report:";
export const BUG_APPROVE_ACTION = `${BUG_REPORT_ACTION_PREFIX}approve`;
export const BUG_REJECT_ACTION = `${BUG_REPORT_ACTION_PREFIX}reject`;

export type BugReportState = "pending" | "approved" | "rejected";

export const MAX_ISSUE = 200;
export const MAX_SUMMARY = 500;
export const MAX_PLAN = 700;

/** The same thread + issue is not put to the owner twice within this long. */
export const DEDUPE_MS = 86_400_000;
/** Reports at all within `DEDUPE_MS`: past this the owner is not asked again, so a looping turn cannot flood the DM. */
export const MAX_PER_DAY = 10;

/** A Slack message link: channel thread, DM or DM thread alike. */
export const SLACK_LINK_RE = /^https:\/\/[\w.-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d+(\?[\w=&.%-]*)?$/;

export type BugReportInput = {
  readonly thread: string;
  readonly issue: string;
  readonly summary: string;
  readonly plan: string;
};

const FLAGS = ["thread", "issue", "summary", "plan"] as const;

/** `--thread <link> --issue "..." --summary "..." --plan "..."`, in any order, `--flag=value` too. */
export const parseReport = (rest: string): { ok: true; input: BugReportInput } | { ok: false; error: string } => {
  const found: Record<string, string> = {};
  const tokens = tokenize(rest);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? "";
    const m = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(t);
    const name = m?.[1];
    if (!name || !(FLAGS as readonly string[]).includes(name)) return { ok: false, error: `I do not know \`${t}\`` };
    const value = m[2] ?? tokens[++i];
    if (value === undefined || value.startsWith("--")) return { ok: false, error: `\`--${name}\` needs a value` };
    found[name] = value;
  }
  const link = unwrapLink((found.thread ?? "").trim());
  if (!SLACK_LINK_RE.test(link)) return { ok: false, error: "`--thread` is the Slack link of the thread (or DM) where the bug showed" };
  const issue = cleanLine(found.issue ?? "", MAX_ISSUE);
  const plan = cleanLine(found.plan ?? "", MAX_PLAN);
  if (!issue) return { ok: false, error: "`--issue` says what is wrong" };
  if (!plan) return { ok: false, error: "`--plan` says how you would fix it" };
  return { ok: true, input: { thread: link, issue, summary: cleanLine(found.summary ?? "", MAX_SUMMARY), plan } };
};

/** What makes two reports the same one: the thread and the issue's words, case and spacing aside. */
export const fingerprintOf = (i: BugReportInput): string =>
  `${i.thread.split("?")[0]}|${i.issue.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()}`;

/**
 * The channel and thread root a report's Slack link points at: `thread_ts` when
 * the link carries one (a reply), else the linked message's own ts. undefined
 * when it is not a message link.
 */
export const linkThread = (link: string): { channelId: string; threadTs: string } | undefined => {
  const m = /\/archives\/([A-Z0-9]+)\/p(\d{7,})(?:\?([^#]*))?/.exec(link);
  if (!m?.[1] || !m[2]) return undefined;
  const fromQuery = new URLSearchParams(m[3] ?? "").get("thread_ts");
  return { channelId: m[1], threadTs: fromQuery ?? `${m[2].slice(0, -6)}.${m[2].slice(-6)}` };
};

/** Whether any of these reports' links point at this channel and thread. */
export const reportsCover = (
  reports: readonly { readonly threadLink: string }[],
  channelId: string,
  threadTs: string,
): boolean => {
  if (!threadTs) return false;
  return reports.some((r) => {
    const t = linkThread(r.threadLink);
    return t?.channelId === channelId && t.threadTs === threadTs;
  });
};

/** The owner's DM: where, what, why, the plan, and what each button does. */
export const approvalText = (id: number, i: BugReportInput): string =>
  [
    `🐞 *I found a bug in myself* (#${id})`,
    `*Where:* <${i.thread}|the thread>`,
    `*Issue:* ${i.issue}`,
    ...(i.summary ? [`*Cause:* ${i.summary}`] : []),
    `*Fix plan:* ${i.plan}`,
    "Approve and I start the fix. Reject and I leave it.",
  ].join("\n");

export const settledText = (id: number, i: BugReportInput, kind: "approved" | "rejected", by: string): string =>
  `🐞 bug #${id} - ${kind === "approved" ? "approved by" : "rejected by"} <@${by}>${kind === "approved" ? ", fixing it" : ", leaving it"}\n*Issue:* ${i.issue}\n<${i.thread}|the thread>`;

/** What the fix turn the owner's Approve press starts is told to do. */
export const approvedBrief = (id: number, i: BugReportInput): string =>
  [
    `Bug #${id} is approved by the owner (they pressed Approve): this is the owner asking for the fix, so fix it now, in the usual way (a worktree and a PR), and tell the owner here when it is up.`,
    `thread: ${i.thread}`,
    `issue: ${i.issue}`,
    ...(i.summary ? [`cause: ${i.summary}`] : []),
    `plan: ${i.plan}`,
  ].join("\n");
