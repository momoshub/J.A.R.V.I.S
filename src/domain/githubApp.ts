/**
 * GitHub App - the pure half of "somebody called the bot from GitHub".
 *
 * Nothing here talks to GitHub or Slack. It checks a webhook's signature,
 * decides whether a delivery is a call at all (a mention of the app, or the
 * trigger label), whether it came from an org the app may act for, and what
 * every line it writes says. The app is public so an org can install it, which
 * means anybody can install it: the owner allowlist is the thing that keeps a
 * stranger's repository from spending somebody's Claude token.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** One call from GitHub, reduced to what a turn needs. */
export type GithubTrigger = {
  /** `X-GitHub-Delivery`, the dedupe key. */
  readonly deliveryId: string;
  /** `issue_comment`, `pull_request_review_comment`, ... plus the action. */
  readonly event: string;
  readonly installationId: number;
  /** Login of the account the repository belongs to (the installation's org). */
  readonly owner: string;
  /** `owner/repo`. */
  readonly repo: string;
  readonly number: number;
  readonly isPr: boolean;
  readonly title: string;
  /** html url of the issue or PR. */
  readonly url: string;
  /** html url of the comment or review, when the call was one. */
  readonly commentUrl?: string;
  /**
   * API path (no leading slash) to add a reaction to what triggered it, when
   * GitHub has one - a submitted review does not.
   */
  readonly reactionPath?: string;
  /** What was asked: the comment / review body, or the issue body for a label. */
  readonly body: string;
  /** How it was called: a mention, or the trigger label. */
  readonly via: "mention" | "label";
  /** GitHub login of whoever called. */
  readonly sender: string;
};

export type TriggerOptions = {
  /** App slug, so `@<slug>` is a mention and `<slug>[bot]` is the app itself. */
  readonly slug: string;
  /** Label that calls the app when added to an issue or PR. */
  readonly label: string;
};

export type TriggerDecision =
  | { readonly kind: "trigger"; readonly trigger: GithubTrigger }
  | { readonly kind: "ignore"; readonly reason: string };

/**
 * `X-Hub-Signature-256` is `sha256=<hex hmac of the raw body>`. Compared in
 * constant time; anything malformed is simply not a match.
 */
export const verifySignature = (secret: string, rawBody: Uint8Array | string, header: string | null): boolean => {
  if (!secret || !header) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m?.[1]) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(m[1], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
};

/** Comma list of owner logins, lowercased; empty entries dropped. */
export const parseAllowedOwners = (csv: string | undefined): string[] =>
  (csv ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export const isAllowedOwner = (owner: string, allowed: readonly string[]): boolean =>
  !!owner && allowed.includes(owner.toLowerCase());

/** `@slug` as a whole word - `@slug-two` and `foo@slug` are not it. */
export const mentions = (body: string, slug: string): boolean => {
  if (!slug) return false;
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_@-])@${escaped}(?![A-Za-z0-9_-])`, "i").test(body);
};

// --- payload narrowing -------------------------------------------------------

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Whether a delivery is a call to the app, and if so the trigger it carries.
 * Bots (the app itself included) are ignored first, so nothing the app writes
 * can ever call it again.
 */
export const detectTrigger = (
  event: string,
  deliveryId: string,
  payload: unknown,
  opts: TriggerOptions,
): TriggerDecision => {
  const p = obj(payload);
  if (!p) return { kind: "ignore", reason: "no payload" };
  const action = str(p.action);
  const name = `${event}.${action}`;
  const sender = obj(p.sender);
  const login = str(sender?.login);
  if (str(sender?.type) === "Bot" || login.toLowerCase() === `${opts.slug.toLowerCase()}[bot]`) {
    return { kind: "ignore", reason: `${name} from a bot (${login})` };
  }
  const repository = obj(p.repository);
  const repo = str(repository?.full_name);
  const owner = str(obj(repository?.owner)?.login) || str(obj(obj(p.installation)?.account)?.login);
  const installationId = num(obj(p.installation)?.id);
  if (!repo || !owner || installationId === undefined || !login) {
    return { kind: "ignore", reason: `${name} without repository, installation or sender` };
  }
  const base = { deliveryId, event: name, installationId, owner, repo, sender: login };

  const mentioned = (body: string) => mentions(body, opts.slug);

  switch (name) {
    case "issue_comment.created": {
      const issue = obj(p.issue);
      const comment = obj(p.comment);
      const body = str(comment?.body);
      const number = num(issue?.number);
      const id = num(comment?.id);
      if (number === undefined || !mentioned(body)) return { kind: "ignore", reason: `${name} without a mention` };
      return {
        kind: "trigger",
        trigger: {
          ...base,
          number,
          isPr: !!obj(issue?.pull_request),
          title: str(issue?.title),
          url: str(issue?.html_url),
          commentUrl: str(comment?.html_url) || undefined,
          ...(id !== undefined ? { reactionPath: `repos/${repo}/issues/comments/${id}/reactions` } : {}),
          body,
          via: "mention",
        },
      };
    }
    case "pull_request_review_comment.created": {
      const pr = obj(p.pull_request);
      const comment = obj(p.comment);
      const body = str(comment?.body);
      const number = num(pr?.number);
      const id = num(comment?.id);
      if (number === undefined || !mentioned(body)) return { kind: "ignore", reason: `${name} without a mention` };
      return {
        kind: "trigger",
        trigger: {
          ...base,
          number,
          isPr: true,
          title: str(pr?.title),
          url: str(pr?.html_url),
          commentUrl: str(comment?.html_url) || undefined,
          ...(id !== undefined ? { reactionPath: `repos/${repo}/pulls/comments/${id}/reactions` } : {}),
          body,
          via: "mention",
        },
      };
    }
    case "pull_request_review.submitted": {
      const pr = obj(p.pull_request);
      const review = obj(p.review);
      const body = str(review?.body);
      const number = num(pr?.number);
      if (number === undefined || !mentioned(body)) return { kind: "ignore", reason: `${name} without a mention` };
      // A review has no reactions endpoint, so nothing to put eyes on.
      return {
        kind: "trigger",
        trigger: {
          ...base,
          number,
          isPr: true,
          title: str(pr?.title),
          url: str(pr?.html_url),
          commentUrl: str(review?.html_url) || undefined,
          body,
          via: "mention",
        },
      };
    }
    case "issues.labeled":
    case "pull_request.labeled": {
      const isPr = event === "pull_request";
      const item = obj(isPr ? p.pull_request : p.issue);
      const label = str(obj(p.label)?.name);
      const number = num(item?.number);
      if (number === undefined || label.toLowerCase() !== opts.label.toLowerCase()) {
        return { kind: "ignore", reason: `${name} with another label (${label || "none"})` };
      }
      return {
        kind: "trigger",
        trigger: {
          ...base,
          number,
          isPr,
          title: str(item?.title),
          url: str(item?.html_url),
          reactionPath: `repos/${repo}/issues/${number}/reactions`,
          body: str(item?.body),
          via: "label",
        },
      };
    }
    default:
      return { kind: "ignore", reason: `${name} is not a trigger` };
  }
};

// --- what it says ------------------------------------------------------------

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** A request quoted for Slack: every line prefixed, clipped so a long issue body stays a quote. */
export const quoteForSlack = (body: string, max = 600): string => {
  const text = clip(body.trim(), max);
  return text ? text.split("\n").map((l) => `> ${l}`).join("\n") : "> (no text)";
};

/** The channel post that opens the thread the turn runs in. */
export const announceTrigger = (t: GithubTrigger, slackId: string, label: string): string => {
  const how = t.via === "label" ? `labelled it \`${label}\`` : "asked";
  const where = `<${t.url}|${t.repo}#${t.number}>`;
  return `🐙 <@${slackId}> ${how} on GitHub: ${where} - ${t.title}\n${quoteForSlack(t.body)}`;
};

/** The one comment a caller nobody can place on Slack gets. */
export const unknownSenderComment = (login: string, prefix: string): string =>
  [
    `@${login} I cannot tell who you are on Slack yet, so I did not run this.`,
    "",
    `Link your GitHub login once, from Slack: \`${prefix} review-inbox link ${login}\` (an admin can do it for you with \`${prefix} review-inbox link ${login} @you\`). Then call me again.`,
  ].join("\n");

/** Said on GitHub when the turn died before answering there. */
export const failedRunComment = (): string =>
  "I hit an error before I could finish this one, so there is no answer from me here. Call me again to retry.";

/**
 * What a turn is handed. It runs in the Slack thread as the person who called,
 * and is told that the ANSWER belongs on GitHub - through the helper, never a
 * raw API call, and never with Slack markup or an attribution line in it.
 */
export const githubTurnPrompt = (t: GithubTrigger, helperPath: string): string => {
  const kind = t.isPr ? "pull request" : "issue";
  const call =
    t.via === "label"
      ? `They added the trigger label to this ${kind}, so the ${kind} itself is the request.`
      : `They mentioned the app in a ${t.event.startsWith("pull_request_review.") ? "review" : "comment"}${
          t.commentUrl ? ` (${t.commentUrl})` : ""
        }.`;
  return [
    `This was called from GitHub, not typed here. ${call}`,
    "",
    `- repository: ${t.repo}`,
    `- ${kind}: #${t.number} ${t.title}`,
    `- url: ${t.url}`,
    `- is a pull request: ${t.isPr ? "yes" : "no"}`,
    `- GitHub user: ${t.sender}`,
    "",
    "Their request, verbatim:",
    "<<<",
    t.body.trim() || "(empty)",
    ">>>",
    "",
    `Read the ${kind} (and its diff, if it is a pull request) with \`gh\` before answering. Do what they asked.`,
    "",
    "Your answer goes back to GitHub. When you are done, write your final answer to a file and post it with:",
    `  ${helperPath} ${t.repo} ${t.number} <file>`,
    "It is posted as the app, on that same issue or pull request. Write it as a GitHub comment in GitHub Markdown: no Slack syntax (no <@U...> mentions, no <url|label> links, no :emoji: codes for meaning), no signature, and no attribution or 'generated with' line. Post once, at the end; a second post only if they asked for follow-ups.",
    "Then reply here in Slack with one or two lines saying what you did and linking the comment.",
  ].join("\n");
};

/**
 * Slack text made safe for a GitHub comment: Slack links and mentions turned
 * into plain Markdown, and any attribution line dropped. Used on whatever the
 * helper is handed and on the fallback that posts a turn's reply.
 */
export const toGithubComment = (text: string): string =>
  text
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/<#[CG][A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<#[CG][A-Z0-9]+>/g, "a Slack channel")
    .replace(/<@[UW][A-Z0-9]+(?:\|([^>]+))?>/g, (_m, name: string | undefined) => (name ? `@${name}` : "someone"))
    .replace(/<!(here|channel|everyone)>/g, "")
    .split("\n")
    .filter((l) => !/^\s*(co-authored-by:|🤖?\s*generated with\b)/i.test(l))
    .join("\n")
    .trim();
