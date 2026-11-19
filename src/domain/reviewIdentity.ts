/**
 * Review identity - the pure half of "a review that starts by itself".
 *
 * A review is asked for in one of two ways, and the way decides who the
 * comments are written as: a request to the GitHub App is answered as the app,
 * a request to the host's own GitHub account as that account (the human). The
 * approval is always the human's, whichever way it was asked: an app approving
 * code is not a sign-off anybody agreed to.
 *
 * Nothing here talks to GitHub or Slack. It names the identities, builds the
 * keys that make a review run once per PR head, and writes every line the
 * review's Slack thread says.
 */

/** Who a review's comments and change requests are posted as. Approvals are never the app's. */
export type ReviewIdentity = "app" | "human";

/** `jv:` buttons with this prefix are decided in code by their own listener, never a turn for the model. */
export const REVIEW_RUN_ACTION_PREFIX = "jv:review-run:";
export const REVIEW_RUN_APPROVE_ACTION = `${REVIEW_RUN_ACTION_PREFIX}approve`;
export const REVIEW_RUN_REJECT_ACTION = `${REVIEW_RUN_ACTION_PREFIX}reject`;

/**
 * Where a review stands. `claimed` is the instant between the dedupe and the
 * decision; `asking` waits on the owner's button; `failed` (and only `failed`)
 * may be claimed again, so a review the process died in the middle of is not
 * lost for good.
 */
export type ReviewRunState = "claimed" | "asking" | "running" | "done" | "failed" | "rejected";

/** `owner/repo#n`, lowercased: the one key a PR's thread and runs go under. */
export const prKeyOf = (repo: string, number: number): string => `${repo.toLowerCase()}#${number}`;

/** `owner/repo` and the number out of a PR url, or undefined when it is not one. */
export const parsePrUrl = (url: string): { repo: string; number: number } | undefined => {
  const m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i.exec(url);
  return m?.[1] && m[2] ? { repo: m[1], number: Number(m[2]) } : undefined;
};

/** A login without GitHub's bot decorations, lowercased, so `app/x`, `x[bot]` and `x` are one account. */
export const bareLogin = (login: string): string =>
  login
    .trim()
    .replace(/^app\//i, "")
    .replace(/\[bot\]$/i, "")
    .toLowerCase();

export const sameLogin = (a: string, b: string): boolean => !!a && !!b && bareLogin(a) === bareLogin(b);

/**
 * Whether a comment on a PR asks the app to review it, rather than to do
 * something else. The mention is taken out first, so the app's own name (which
 * may contain the word) never counts. The ask is a request: the text opens with
 * `review`, `re-review` or `approve` (after an optional "please" / "can you"),
 * so "address the review comments" and "don't approve yet" stay the general
 * calls they always were.
 */
export const asksForReview = (body: string, slug: string): boolean => {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const text = body
    .replace(new RegExp(`@${escaped}(\\[bot\\])?`, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(?:(?:please|pls|kindly|hey|hi)[ ,]+)*(?:(?:can|could|would|will) you (?:please )?)?(?:re-?review|review|approve)\b/i.test(text);
};

/** What the person said next to the mention, as a steering note for the review. */
export const reviewNoteOf = (body: string, slug: string, max = 500): string => {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const text = body
    .replace(new RegExp(`@${escaped}(\\[bot\\])?`, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

// --- what the thread says ----------------------------------------------------

export type Asker = { readonly login: string; readonly slackId?: string };

const who = (a: Asker): string => (a.slackId ? `<@${a.slackId}>` : `\`${a.login}\``);
const prLink = (url: string, repo: string, number: number): string => `<${url}|${repo}#${number}>`;
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const quote = (body: string, max = 500): string => {
  const text = clip(body.trim(), max);
  return text ? text.split("\n").map((l) => `> ${l}`).join("\n") : "";
};

/** What a review request is addressed to, for the line that announces it. */
const addressee = (identity: ReviewIdentity, account: string): string =>
  identity === "app" ? `the app (\`${account}\`)` : `\`${account}\``;

export type RequestedLine = {
  readonly asker: Asker;
  readonly identity: ReviewIdentity;
  /** Login of the account the request went to. */
  readonly account: string;
  readonly url: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly headSha: string;
};

/** The event that opens a PR's thread - and, when the thread exists, the line a later request adds to it. */
export const requestedText = (r: RequestedLine): string =>
  `👀 ${who(r.asker)} asked ${addressee(r.identity, r.account)} to review ${prLink(r.url, r.repo, r.number)} - ${r.title} (\`${r.headSha.slice(0, 7)}\`)`;

/** A request on a head that already has a review under this identity: nothing runs again, and the thread says so. */
export const alreadyReviewedText = (headSha: string): string =>
  `↩️ \`${headSha.slice(0, 7)}\` already has a review this way - a new push, asked for again, gets another`;

/** Why a review waits on the owner instead of running. */
export type AskReason = "no-token" | "unknown" | "unlinked";

export type AskLine = {
  readonly asker: Asker;
  readonly reason: AskReason;
  readonly ownerSlackId: string;
  readonly identity: ReviewIdentity;
  readonly url: string;
  readonly repo: string;
  readonly number: number;
};

/** The owner's question: run it anyway, or not. Two buttons go with it. */
export const askText = (a: AskLine): string =>
  [
    a.reason === "unknown"
      ? `🔑 \`${a.asker.login}\` asked for a review of ${prLink(a.url, a.repo, a.number)} and I cannot tell who that is on Slack, so there is no Claude Code token to run it on.`
      : a.reason === "unlinked"
        ? `🔑 \`${a.asker.login}\` asked for a review of ${prLink(a.url, a.repo, a.number)}. They look like ${who(a.asker)} by name, but the login is not linked, and I do not spend anyone's Claude Code token on a name match.`
        : `🔑 ${who(a.asker)} asked for a review of ${prLink(a.url, a.repo, a.number)} but has no Claude Code token on file, so it did not start.`,
    `<@${a.ownerSlackId}> run it anyway, on your credential or the bot's? Comments go out as ${a.identity === "app" ? "the app" : "the GitHub account"}, the approval (if it is clean) as the GitHub account.`,
    "Approve and I review it. Reject and nothing runs.",
  ].join("\n");

export const settledAskText = (a: AskLine, decision: "approved" | "rejected", by: string): string =>
  decision === "approved"
    ? `🔍 review of ${prLink(a.url, a.repo, a.number)} approved by <@${by}> - running it`
    : `🚫 review of ${prLink(a.url, a.repo, a.number)} rejected by <@${by}> - nothing ran`;

/** The short note the thread gets when the owner says no. */
export const rejectedNote = (url: string, by: string): string => `🚫 not reviewing ${url} - <@${by}> said no, nothing ran`;

/** The line a refused or stranger's press gets, privately. */
export const reviewRunPressNotice = (kind: "not-owner" | "wrong-message" | "decided"): string =>
  kind === "not-owner"
    ? "Only the owner decides whether a review runs without its asker's own token. Nothing changed."
    : kind === "wrong-message"
      ? "That review is decided from the thread it was asked in. Nothing changed."
      : "That review is already decided. Nothing changed.";

/** The thread's lines for what other people do on the PR after it is opened. */
export type ActivityKind = "comment" | "changes" | "approved" | "reviewed";

export type ActivityLine = {
  readonly kind: ActivityKind;
  readonly login: string;
  readonly url: string;
  readonly body: string;
  /** Link to the comment or review itself, when GitHub gave one. */
  readonly link?: string;
};

export const activityText = (a: ActivityLine): string => {
  const at = a.link ? `<${a.link}|${a.kind === "comment" ? "comment" : "review"}>` : a.kind === "comment" ? "a comment" : "a review";
  const quoted = quote(a.body);
  const head =
    a.kind === "approved"
      ? `✅ \`${a.login}\` approved (${at})`
      : a.kind === "changes"
        ? `🚫 \`${a.login}\` requested changes (${at})`
        : a.kind === "reviewed"
          ? `📝 \`${a.login}\` reviewed (${at})`
          : `💬 \`${a.login}\` commented (${at})`;
  return quoted ? `${head}\n${quoted}` : head;
};

/** The failure line of a review turn that threw. */
export const failedReviewText = (url: string, why: string): string =>
  `⚠️ the review of ${url} stopped: ${clip(why, 300)} - request it again to retry`;
