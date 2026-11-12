/**
 * Review inbox - a timer that asks GitHub which PRs requested a review from the
 * bot's account and posts each new request into a channel, with the line a
 * person types to have it reviewed.
 *
 * It only ANNOUNCES. A quick review runs when a human asks for it in Slack
 * (`@bot review <pr>` or `quick-review <pr>`), never because GitHub said so:
 * a review spends the asker's own Claude token and nobody asked here. It used
 * to start one in the post's thread as the requester; that auto-run is gone.
 *
 * Polling, not a webhook: the bot runs on a laptop with no public address, and
 * a minute of delay on an announcement is nothing.
 */
import {
  advanceCursor,
  announceRequest,
  githubLinkKey,
  matchByName,
  newRequests,
  type ReviewRequest,
} from "../domain/reviewInbox.ts";
import type { AllowedUser } from "../domain/types.ts";
import type { Clock } from "./ports.ts";
import { logAndIgnore } from "./ignoredError.ts";

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
  /** Post the announcement into the channel. */
  post: (channel: string, text: string) => Promise<string | undefined>;
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
  const name = await deps.githubName(login).catch(logAndIgnore("github name lookup"));
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
    const ts = await deps.post(channel, announceRequest(r, slackId, account, deps.prefix));
    if (!ts) log(`could not post ${r.prUrl} into ${channel}`);
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
