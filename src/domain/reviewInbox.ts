/**
 * Review inbox - the pure half of "somebody asked the bot's GitHub account for
 * a review, so post it and review it".
 *
 * Nothing here talks to GitHub or Slack. It decides which requests are new,
 * who on Slack asked, and what each line says. A review spends the
 * requester's Claude token when they have one, so the matching is deliberately strict: an
 * explicit link, or exactly one person whose name matches - never a guess
 * between two.
 */

/** One review request of the bot's account on an open PR. */
export type ReviewRequest = {
  readonly prUrl: string;
  /** `owner/repo`. */
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  /** GitHub login of whoever requested the review. */
  readonly requester: string;
  /** ISO time of the request event - the cursor moves on this. */
  readonly requestedAt: string;
};

/** Setting key prefix linking a GitHub login to a Slack id. */
export const GITHUB_LINK_PREFIX = "github_login:";
export const githubLinkKey = (login: string): string => `${GITHUB_LINK_PREFIX}${login.toLowerCase()}`;

/**
 * Requests made after the cursor, oldest first, one per PR + time. An
 * unparseable cursor counts as "nothing seen", which only happens if someone
 * hand-edits the setting.
 */
export const newRequests = (requests: readonly ReviewRequest[], cursor: string): ReviewRequest[] => {
  const after = Date.parse(cursor);
  const seen = new Set<string>();
  return requests
    .filter((r) => !Number.isFinite(after) || Date.parse(r.requestedAt) > after)
    .filter((r) => {
      const key = `${r.prUrl}@${r.requestedAt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
};

/** The latest request time in a batch, or the cursor if none is later. */
export const advanceCursor = (cursor: string, handled: readonly ReviewRequest[]): string =>
  handled.reduce((at, r) => (Date.parse(r.requestedAt) > Date.parse(at) ? r.requestedAt : at), cursor);

/** Lowercase, no diacritics (Vietnamese đ included), single spaces. */
export const normaliseName = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export type SlackCandidate = { readonly slackId: string; readonly displayName: string };

/**
 * The one Slack user a GitHub account belongs to, by name. Matches the GitHub
 * display name or the login against the Slack display name, normalised. Two
 * candidates is no answer: picking one would spend somebody's token on a guess.
 */
export const matchByName = (
  login: string,
  githubName: string | undefined,
  candidates: readonly SlackCandidate[],
): string | undefined => {
  const wanted = new Set([normaliseName(login), ...(githubName ? [normaliseName(githubName)] : [])].filter(Boolean));
  const hits = candidates.filter((c) => wanted.has(normaliseName(c.displayName)));
  return hits.length === 1 ? hits[0]?.slackId : undefined;
};

/** The channel post that opens the thread a review lands in. */
export const announceRequest = (r: ReviewRequest, requesterSlackId: string | undefined, account: string): string =>
  `👀 ${requesterSlackId ? `<@${requesterSlackId}>` : `\`${r.requester}\``} requested a review from \`${account}\` on <${r.prUrl}|${r.repo}#${r.number}> - ${r.title}`;

export const unknownRequester = (login: string, prefix: string): string =>
  `I cannot tell who \`${login}\` is on Slack, so no review. \`${prefix} review-inbox link ${login}\` from them (or an admin with \`@someone\`) fixes it`;

/**
 * The review line to run. This path always reviews BEFORE approving; a pal's
 * review already does, and a pal may not pass `--policy` at all.
 */
export const reviewLine = (prUrl: string, palOnly: boolean): string =>
  palOnly ? `review ${prUrl}` : `review ${prUrl} --policy after`;
