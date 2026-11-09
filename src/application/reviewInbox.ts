/**
 * Review inbox - a timer that asks GitHub which PRs requested a review from the
 * bot's account, posts each new request into a channel, and runs `review` in
 * that post's thread as the person who asked.
 *
 * Polling, not a webhook: the bot runs on a laptop with no public address, and
 * a minute of delay on a review that takes ten is nothing.
 *
 * Two hard rules ride on it. The review is always review-then-approve, never
 * approve up front. And it only runs on the requester's own Claude token - no
 * token on file, no review, just a line saying so. Nobody is asked for one
 * here: they asked GitHub, not Slack, and the ask belongs to `token`.
 */
import {
  advanceCursor,
  announceRequest,
  githubLinkKey,
  matchByName,
  newRequests,
  noTokenOnFile,
  reviewLine,
  type ReviewRequest,
  unknownRequester,
} from "../domain/reviewInbox.ts";
import type { AllowedUser } from "../domain/types.ts";
import type { Clock } from "./ports.ts";

/** How often GitHub is asked. Search allows 30 a minute; this uses one. */
export const POLL_MS = 60_000;

export type ReviewInboxDeps = {
  clock: Clock;
  settings: {
    get: (key: string) => string | undefined;
    set: (key: string, value: string) => void;
  };
  /** Channel to post into; empty means off. */
  channel: () => string;
  cursorKey: string;
  /** Open review requests of the bot's account, with who asked and when. */
  requests: (since: string) => Promise<ReviewRequest[]>;
  /** The bot's own GitHub login, for the post. */
  account: () => Promise<string | undefined>;
  /** A GitHub account's display name, for matching to Slack. */
  githubName: (login: string) => Promise<string | undefined>;
  users: { get: (slackId: string) => AllowedUser | undefined; list: () => AllowedUser[] };
  hasToken: (slackId: string) => boolean;
  /** Post; returns the ts so the review can go in its thread. */
  post: (channel: string, text: string, threadTs?: string) => Promise<string | undefined>;
  /** Run a command line as `actor` in a thread. Resolves when it is done. */
  runReview: (req: { actor: AllowedUser; channelId: string; threadTs: string; line: string }) => Promise<void>;
  prefix: string;
  log?: (msg: string) => void;
  onError?: (e: unknown) => void;
};

export type ReviewInbox = { tick: () => Promise<void> };

export type GithubIdentityDeps = {
  settings: { get: (key: string) => string | undefined };
  githubName: (login: string) => Promise<string | undefined>;
  users: { list: () => AllowedUser[] };
};

/**
 * The Slack id a GitHub login belongs to: an explicit `github_login:` link
 * first, otherwise exactly one allowlisted display name matching the GitHub
 * name or login. Shared by everything that runs work on GitHub's say-so (the
 * review inbox, the GitHub App), because a wrong answer spends somebody else's
 * token.
 */
export const slackIdOfGithub = async (deps: GithubIdentityDeps, login: string): Promise<string | undefined> => {
  const linked = deps.settings.get(githubLinkKey(login))?.trim();
  if (linked) return linked;
  const name = await deps.githubName(login).catch(() => undefined);
  const candidates = deps.users.list().map((u) => ({ slackId: u.slackId, displayName: u.displayName }));
  return matchByName(login, name, candidates);
};

export const createReviewInbox = (deps: ReviewInboxDeps): ReviewInbox => {
  const log = deps.log ?? (() => {});
  let running = false;
  let lastPoll = 0;

  const slackIdOf = (login: string) => slackIdOfGithub(deps, login);

  const handle = async (channel: string, account: string, r: ReviewRequest): Promise<void> => {
    const slackId = await slackIdOf(r.requester);
    const ts = await deps.post(channel, announceRequest(r, slackId, account));
    if (!ts) {
      log(`could not post ${r.prUrl} into ${channel}`);
      return;
    }
    const actor = slackId ? deps.users.get(slackId) : undefined;
    if (!slackId || !actor) {
      await deps.post(channel, unknownRequester(r.requester, deps.prefix), ts);
      return;
    }
    if (!deps.hasToken(slackId)) {
      await deps.post(channel, noTokenOnFile(slackId, deps.prefix), ts);
      return;
    }
    // Not awaited: a review takes ten minutes, and the next request should not
    // sit behind it.
    const line = reviewLine(r.prUrl, actor.role === "pal");
    void deps
      .runReview({ actor, channelId: channel, threadTs: ts, line })
      .catch((e) => log(`review of ${r.prUrl} failed: ${e instanceof Error ? e.message : String(e)}`));
  };

  const tick = async (): Promise<void> => {
    const channel = deps.channel().trim();
    if (!channel || running) return;
    const now = deps.clock();
    if (now - lastPoll < POLL_MS) return;
    lastPoll = now;
    running = true;
    try {
      const cursor = deps.settings.get(deps.cursorKey);
      // First run starts from now: a backlog of months-old requests is not
      // what anybody switched this on for.
      if (!cursor) {
        deps.settings.set(deps.cursorKey, new Date(now).toISOString());
        return;
      }
      const fresh = newRequests(await deps.requests(cursor), cursor);
      if (fresh.length === 0) return;
      const account = (await deps.account()) ?? "me";
      for (const r of fresh) {
        await handle(channel, account, r);
        // Moved per request, so a crash halfway never posts the first ones twice.
        deps.settings.set(deps.cursorKey, advanceCursor(deps.settings.get(deps.cursorKey) ?? cursor, [r]));
      }
    } catch (e) {
      log(`poll failed: ${e instanceof Error ? e.message : String(e)}`);
      deps.onError?.(e);
    } finally {
      running = false;
    }
  };

  return { tick };
};
