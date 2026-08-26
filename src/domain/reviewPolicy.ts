/**
 * Per-repository review policy.
 *
 * The default is to approve immediately and reverse it if the review turns up
 * something blocking - fast, and honest about it. Some repositories want the
 * opposite: nothing is approved until a review has actually been written and
 * come back clean. Which repository is which is configuration, never code -
 * this is an open codebase and nobody else's repo belongs in it.
 */

export type ReviewPolicy =
  /** Approve up front, reverse with request-changes if the review finds a blocker. */
  | "approve-first"
  /** Approve only after the review, and only if nothing is blocking. */
  | "approve-after";

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = "approve-first";

/** `owner/repo` from a PR url, lowercased. Undefined when it is not one. */
export const repoOf = (prUrl: string): string | undefined => {
  const m = prUrl.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
};

/** Accepts the shorthand people actually type, or a full url. */
export const repoRefOf = (token: string): string | undefined => {
  const fromUrl = repoOf(token);
  if (fromUrl) return fromUrl;
  const cleaned = token.replace(/^<|>$/g, "").replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "");
  return /^[\w.-]+\/[\w.-]+$/.test(cleaned) ? cleaned.toLowerCase() : undefined;
};

/** Read a stored value back, tolerating anything that is not a known policy. */
export const asReviewPolicy = (value: string | undefined): ReviewPolicy | undefined =>
  value === "approve-after" || value === "approve-first" ? value : undefined;
