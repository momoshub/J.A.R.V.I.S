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

/**
 * A policy asked for on the command itself: `--policy after`, `--policy=first`,
 * `--policy default`. One run only - nothing is written down, so the repo's own
 * setting is untouched and the next review is back on it.
 *
 * Returns the remaining arguments too, so the flag never reaches the url parser
 * or gets mistaken for the free-text note that steers the review.
 */
export type PolicyArg = {
  /** Undefined when nothing was asked for; `default` means the built-in one. */
  asked?: ReviewPolicy | "default";
  /** Everything that was not part of the flag, in order. */
  rest: string[];
  /** Set when a flag was given but its value is not a policy. */
  bad?: string;
};

const policyWord = (word: string): ReviewPolicy | "default" | undefined => {
  const w = word.toLowerCase();
  if (w === "first" || w === "approve-first") return "approve-first";
  if (w === "after" || w === "approve-after") return "approve-after";
  if (w === "default" || w === "reset") return "default";
  return undefined;
};

export const parsePolicyArg = (args: readonly string[]): PolicyArg => {
  const rest: string[] = [];
  let asked: ReviewPolicy | "default" | undefined;
  let bad: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const lower = arg.toLowerCase();
    // `--policy=after` says plainly what it is, so a value that is not a policy
    // is a mistake worth reporting. `policy:after` is a word away from ordinary
    // prose - "check the policy:handler code" - so it only counts when it does
    // name a policy, and otherwise stays in the note where it was typed.
    const explicit = /^--policy=(.*)$/i.exec(arg);
    if (explicit) {
      const found = policyWord(explicit[1] ?? "");
      if (found) asked = found;
      else bad = explicit[1] || "";
      continue;
    }
    const loose = /^policy:(.*)$/i.exec(arg);
    if (loose) {
      const found = policyWord(loose[1] ?? "");
      if (found) {
        asked = found;
        continue;
      }
      rest.push(arg); // prose, not a flag
      continue;
    }
    if (lower === "--policy") {
      const value = args[i + 1] ?? "";
      const found = policyWord(value);
      if (found) {
        asked = found;
        i += 1;
      } else {
        bad = value;
        if (value) i += 1;
      }
      continue;
    }
    // the shorthands, because they are what gets typed in a hurry
    if (lower === "--first" || lower === "--after") {
      asked = lower === "--first" ? "approve-first" : "approve-after";
      continue;
    }
    rest.push(arg);
  }

  return { asked, rest, ...(bad !== undefined ? { bad } : {}) };
};
