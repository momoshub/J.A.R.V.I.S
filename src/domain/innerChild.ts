/**
 * The inner child: the part of the bot that watches the bot.
 *
 * Every so often it reads the turns that ended since it last looked, asks the
 * model which of them show a defect in the bot ITSELF, and for each new one it
 * opens a thread in its own channel and has the bot fix its own source there.
 * No approval step, by request - but it always says what it is about to do and
 * what it did, and it is rate-limited so a bad afternoon cannot become a loop.
 *
 * Everything here is pure: what the triage sees, how its answer is read, and
 * what is said before and after.
 */

import { STANDALONE_REVIEW_RULE } from "./selfUpdate.ts";

/** One finished turn, as the triage sees it. */
export type ObservedTurn = {
  readonly channelId: string;
  readonly threadTs: string;
  readonly slackUserId: string;
  readonly kind: string;
  readonly outcome: string;
  readonly error: string;
  readonly request: string;
  /** What the bot said back, when it was stored. */
  readonly reply: string;
};

export type Severity = "critical" | "bug";

/** A defect the triage believes is in the bot's own code or behaviour. */
export type Finding = {
  /** Stable kebab-case key, so the same defect is never filed twice. */
  readonly fingerprint: string;
  readonly title: string;
  readonly severity: Severity;
  readonly channelId: string;
  readonly threadTs: string;
  readonly evidence: string;
  readonly hint: string;
};

/** How much of each field the triage is shown. Enough to judge, not a transcript. */
const REQUEST_CHARS = 500;
const REPLY_CHARS = 700;
const ERROR_CHARS = 300;

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}...` : t;
};

export const renderTurns = (turns: readonly ObservedTurn[]): string =>
  turns
    .map((t, i) =>
      [
        `#${i + 1} channel=${t.channelId} thread=${t.threadTs || "-"} user=${t.slackUserId} kind=${t.kind} outcome=${t.outcome}`,
        t.error ? `  error: ${clip(t.error, ERROR_CHARS)}` : "",
        `  asked: ${clip(t.request, REQUEST_CHARS) || "-"}`,
        `  replied: ${clip(t.reply, REPLY_CHARS) || "-"}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");

/** The system prompt for the triage run. It has no tools and should not need any. */
export const triageSystem = (botName: string): string => `You are the self-review of ${botName}, a Slack assistant bot. You read a batch of its recent turns and pick out defects in ${botName} ITSELF - its code, its commands, its prompts, its Slack handling.

Report only things worth fixing in ${botName}'s own source:
- a turn that failed or crashed because of the bot (an exception, a broken command, a malformed Slack post, a tool the bot should have had)
- a command that did the wrong thing, or a reply that broke a rule the bot is clearly meant to follow, in a way that will happen again
- a person telling the bot it is broken, wrong, or misbehaving

Do NOT report:
- bugs in the product the team builds - those belong to the team's tracker, not here
- a turn that ran out of time on a big investigation, a person's typo, a refused permission working as designed, a one-off model slip with no code cause
- anything already in the known list you are given

Be strict. Most batches contain nothing, and an empty answer is the normal one. A false alarm costs a whole self-fix run.

Answer with ONLY a JSON array, no prose and no code fence. Each item:
{"fingerprint":"short-kebab-key","title":"one line","severity":"critical|bug","channelId":"...","threadTs":"...","evidence":"what in the turn shows it","hint":"where in the code you would look, if you can tell"}
"critical" means people are being failed right now. Use the channel and thread of the turn that shows it. Answer [] when there is nothing.`;

export const triageMessage = (turns: readonly ObservedTurn[], known: readonly string[]): string =>
  [
    known.length ? `Known, do not report again:\n${known.map((k) => `- ${k}`).join("\n")}` : "Known: none",
    "",
    "Recent turns:",
    renderTurns(turns),
  ].join("\n");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** A fingerprint is a key, so it is normalised the same way every time. */
export const normaliseFingerprint = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

/**
 * Read the triage's answer. Anything that is not a well-formed finding is
 * dropped rather than guessed at: a self-fix started on a half-parsed item is
 * worse than one missed until the next look.
 */
export const parseFindings = (raw: string): Finding[] => {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Finding[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const fingerprint = normaliseFingerprint(str(item.fingerprint) || str(item.title));
    const title = str(item.title);
    const severity = str(item.severity);
    const channelId = str(item.channelId);
    if (!fingerprint || !title || !channelId) continue;
    if (severity !== "critical" && severity !== "bug") continue;
    out.push({
      fingerprint,
      title: clip(title, 200),
      severity,
      channelId,
      threadTs: str(item.threadTs),
      evidence: clip(str(item.evidence), 600),
      hint: clip(str(item.hint), 400),
    });
  }
  return out;
};

/** Critical first, so a capped batch spends its slots on what hurts most. */
export const byUrgency = (findings: readonly Finding[]): Finding[] =>
  [...findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));

/** A link to the thread a finding came from. */
export const sourceLink = (channelId: string, threadTs: string): string =>
  threadTs
    ? `<https://slack.com/archives/${channelId}/p${threadTs.replace(".", "")}|source thread>`
    : `<#${channelId}>`;

/** What a filed issue carries into its notices and its fix run. */
export type IssueBrief = {
  readonly id: number;
  readonly title: string;
  readonly severity: Severity;
  readonly evidence: string;
  readonly sourceChannel: string;
  readonly sourceThread: string;
};

/** Posted in the channel BEFORE the fix starts. It becomes the fix thread's root. */
export const beforeNotice = (i: IssueBrief): string =>
  [
    `:child: inner child found a ${i.severity === "critical" ? "*critical* " : ""}bug in me, issue #${i.id}: *${i.title}*`,
    `${sourceLink(i.sourceChannel, i.sourceThread)} - ${clip(i.evidence.split("\n")[0] ?? "", 300) || "no detail"}`,
    "fixing it myself in this thread now, no approval needed. I will say here when it is done",
  ].join("\n");

/** What the fix run is told. It runs as a normal full-access turn in that thread. */
export const fixPrompt = (i: IssueBrief, sourceDir: string, restartScript: string): string =>
  [
    `inner child, issue #${i.id}: fix this defect in your own source (${sourceDir}).`,
    "",
    `title: ${i.title}`,
    `severity: ${i.severity}`,
    `seen in: channel ${i.sourceChannel}, thread ${i.sourceThread || "-"} (read it with the slack-read helper)`,
    `evidence: ${i.evidence || "-"}`,
    "",
    "how to do it:",
    "- first read the source thread and confirm it really is a defect in your own code. if it is not, change nothing and say why",
    // Other sessions edit the main folder at the same time, so the fix never
    // touches it: it lands through its own worktree, a PR and a fast-forward.
    `- never edit ${sourceDir} itself, other sessions are working in it. cut a worktree: \`git -C ${sourceDir} fetch origin && git -C ${sourceDir} worktree add ${sourceDir}/.claude/worktrees/issue-${i.id} -b fix/issue-${i.id} origin/main\`, then \`bun install\` there and do all the work in it`,
    "- make the smallest fix that solves it, with a test that fails without it. follow the repo's CLAUDE.md",
    "- never weaken a role check, a safety rule or the inner child itself to make a problem go away",
    "- in the worktree run `bun run typecheck` and `bun test`. if they do not pass before a PR exists, push nothing, remove the worktree and report that",
    `- when they pass: commit (no co-author line), push the branch and open a PR`,
    `- ${STANDALONE_REVIEW_RULE}`,
    "- if the reviewer is still not clean after 3 rounds, or it died or went silent, or the checks or CI cannot be made green again after a review fix, merge nothing, leave the PR open, remove the worktree, name the PR and what is still open in your summary, end with `RESULT: not fixed`, and stop there - skip the steps below",
    `- then merge it yourself with \`bin/merge-when-green.sh <pr>\` - CI, the checks you ran and the reviewer are the gate. if CI stays red, treat it like the case above. the PR body carries no attribution line, no "Generated with ..." of any kind`,
    `- then bring it home: \`git -C ${sourceDir} pull --ff-only origin main\`. the main folder may hold someone else's uncommitted work - never revert, reset, stash or rewrite it. if the pull is refused, stop and report that`,
    `- remove the worktree, then run ${restartScript}`,
    "",
    "reply with a short summary: what was wrong, what you changed (files), and the test. end with exactly one line: `RESULT: fixed` or `RESULT: not fixed`",
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n");

export type FixOutcome = "fixed" | "not_fixed";

/** The fix run's own verdict. No verdict counts as not fixed: claim nothing it did not claim. */
export const readOutcome = (reply: string): FixOutcome =>
  /RESULT:\s*fixed\b/i.test(reply) && !/RESULT:\s*not\s+fixed/i.test(reply) ? "fixed" : "not_fixed";

/** Posted in the fix thread AFTER the run, on top of the run's own reply. */
export const afterNotice = (id: number, outcome: FixOutcome | "failed", detail = ""): string => {
  if (outcome === "fixed") return `:white_check_mark: issue #${id} fixed, I restart once idle`;
  if (outcome === "failed") return `:x: issue #${id} - the fix run itself failed${detail ? `: ${clip(detail, 300)}` : ""}`;
  return `:warning: issue #${id} not fixed, left open for a human`;
};
