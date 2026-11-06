/**
 * Review guard - one review per PR at a time.
 *
 * A review can be asked for twice over: a GitHub review request lands in the
 * review inbox, and the same person also types `review <pr>` in Slack. Both
 * paths end in the `review` command, so this is where they meet. Without it
 * the PR got two approvals, two comments and two runs on the asker's token.
 *
 * A claim holds while the review runs, and for a short while after: the inbox
 * polls once a minute, so a request made alongside a quick review can still
 * arrive once that review is done.
 */
import type { Clock } from "./ports.ts";

/** How long a finished review still counts as fresh. */
export const REVIEW_COOLDOWN_MS = 10 * 60_000;

/** Where a review of a PR is (or was) running. */
export type ReviewHolder = {
  readonly channelId: string;
  readonly threadTs?: string;
  /** Set once the review is done; undefined while it runs. */
  readonly doneAt?: number;
};

export type ReviewGuard = {
  /** Claims the PR. Returns whoever already holds it, or undefined if this call got it. */
  claim: (prUrl: string, where: { channelId: string; threadTs?: string }) => ReviewHolder | undefined;
  /** Marks a claimed review as done; it stays held for the cooldown. */
  release: (prUrl: string) => void;
};

/** `owner/repo#n`, lowercased, so the same PR written two ways is one key. */
export const prKey = (prUrl: string): string => {
  const m = prUrl.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i);
  return m ? `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() : prUrl.trim().toLowerCase();
};

export const createReviewGuard = (clock: Clock, cooldownMs = REVIEW_COOLDOWN_MS): ReviewGuard => {
  const held = new Map<string, ReviewHolder>();

  const claim: ReviewGuard["claim"] = (prUrl, where) => {
    const key = prKey(prUrl);
    const now = clock();
    const holder = held.get(key);
    if (holder && (holder.doneAt === undefined || now - holder.doneAt < cooldownMs)) return holder;
    held.set(key, { channelId: where.channelId, threadTs: where.threadTs });
    return undefined;
  };

  const release: ReviewGuard["release"] = (prUrl) => {
    const key = prKey(prUrl);
    const holder = held.get(key);
    if (holder) held.set(key, { ...holder, doneAt: clock() });
  };

  return { claim, release };
};
