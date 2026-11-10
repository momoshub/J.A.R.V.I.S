/**
 * Slack workspace members, as the Users page searches them.
 *
 * Pure: who counts as a person, and how a typed query matches one. The cache
 * and the Slack calls live in `application/slackDirectory.ts`.
 */

/** One member of the workspace, as `users.list` describes them. */
export type SlackMember = {
  readonly id: string;
  /** The @handle (`name`). */
  readonly handle: string;
  readonly realName: string;
  readonly displayName: string;
  readonly title: string;
  readonly email: string;
  /** A small square avatar url, or "" when Slack gave none. */
  readonly avatar: string;
  readonly deleted: boolean;
  readonly isBot: boolean;
};

/** Slackbot is not flagged as a bot, but nobody means it. */
const SLACKBOT = "USLACKBOT";

/** A deactivated account, a bot or an app user is never someone to add. */
export const isPerson = (m: SlackMember): boolean => !m.deleted && !m.isBot && m.id !== SLACKBOT;

/** Lower-cased and stripped of diacritics, so "minh" finds "Mình". */
export const fold = (s: string): string =>
  s.normalize("NFD").replace(/\p{M}+/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().trim();

const fields = (m: SlackMember): string[] =>
  [m.realName, m.displayName, m.handle, m.email, m.id].map(fold).filter(Boolean);

/**
 * How well a member answers a query, or 0 for not at all. A field that starts
 * with the query beats one that only contains it, and a word inside a name
 * ("ly" in "Thien Ly") counts as a start, so the person typed is first.
 */
export const matchScore = (m: SlackMember, query: string): number => {
  const q = fold(query).replace(/^@/, "");
  if (!q) return 0;
  let best = 0;
  for (const f of fields(m)) {
    if (f === q) return 3;
    if (f.startsWith(q) || f.split(/[\s._@-]+/).some((w) => w.startsWith(q))) best = Math.max(best, 2);
    else if (f.includes(q)) best = Math.max(best, 1);
  }
  return best;
};

/** People matching `query`, best first, then by name. A blank query matches nobody. */
export const searchMembers = (members: readonly SlackMember[], query: string, limit: number): SlackMember[] =>
  members
    .filter(isPerson)
    .map((m) => ({ m, s: matchScore(m, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.m.realName || a.m.handle).localeCompare(b.m.realName || b.m.handle))
    .slice(0, Math.max(0, limit))
    .map((x) => x.m);
