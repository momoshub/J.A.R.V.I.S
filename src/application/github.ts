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
  /** The authenticated account, or undefined if it cannot be resolved. Never throws. */
  whoami: () => Promise<Reviewer | undefined>;
};
