/**
 * GitHub port - the PR actions the bot takes itself, without going through the
 * brain.
 *
 * The `review` command approves up front as a fixed, unconditional step: it is
 * not a judgement call, so it must not wait on a model that first spends half a
 * minute reading the PR. The concrete implementation shells out to `gh`.
 */

import type { Reviewer } from "../domain/types.ts";

export type ApproveResult =
  /** The approval was submitted. */
  | { ok: true }
  /** GitHub (or `gh`) refused - e.g. approving your own PR. `error` is reportable. */
  | { ok: false; error: string };

export type { Reviewer } from "../domain/types.ts";

export type GitHubPort = {
  /** Submit a bodyless approving review on a PR url. Never throws. */
  approve: (prUrl: string) => Promise<ApproveResult>;
  /**
   * GitHub's own verdict on a PR - `CHANGES_REQUESTED`, `APPROVED`, and so on.
   * Undefined when it cannot be read. Asked before approving after a review, so
   * the decision rests on what is actually recorded rather than on what we
   * think the review said.
   */
  reviewDecision: (prUrl: string) => Promise<string | undefined>;
  /**
   * The PR author's login, or undefined when it cannot be read. Never throws.
   * Asked before approving up front, because some authors (a coding agent) are
   * held for a review whatever their repository is on.
   */
  author?: (prUrl: string) => Promise<string | undefined>;
  /** The authenticated account, or undefined if it cannot be resolved. Never throws. */
  whoami: () => Promise<Reviewer | undefined>;
};
