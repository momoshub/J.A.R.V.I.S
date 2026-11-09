/**
 * A user's own Claude Code credential.
 *
 * `review` spawns the Claude Code CLI, and the CLI bills whoever's token it is
 * holding. Run every review on the bot's own credential and one account carries
 * the whole team's usage; run it on the caller's and the cost sits with the
 * person who asked for the work.
 *
 * A token is minted by the user with `claude setup-token`, so the bot never sees
 * anyone's password and never needs one. Nothing here touches storage or Slack -
 * this is only what a token looks like and how to talk about one.
 */

/** Every Claude Code setup token starts with this. */
export const TOKEN_PREFIX = "sk-ant-oat01-";
/** The command that mints one. Quoted everywhere, so nobody has to go looking. */
export const SETUP_COMMAND = "claude setup-token";
/** Shortest credible token: the prefix plus a real body, not a stub. */
const MIN_BODY = 32;

/**
 * Is this a Claude Code setup token? Deliberately shape-only - whether it still
 * authenticates is between the user and Anthropic, and the CLI will say so.
 * An API key (`sk-ant-api03-`) is rejected on purpose: it is a different
 * credential with different billing, and pasting one here is a mistake worth
 * catching rather than storing.
 */
export const isClaudeToken = (value: string | undefined): boolean => {
  const v = (value ?? "").trim();
  return v.startsWith(TOKEN_PREFIX) && v.length >= TOKEN_PREFIX.length + MIN_BODY && !/\s/.test(v);
};

/**
 * How a stored token is referred to out loud: the last four characters and
 * nothing else. Enough for someone to tell two of their own apart, useless to
 * anyone who reads it over their shoulder.
 */
export const tokenHint = (token: string): string => `…${token.trim().slice(-4)}`;

/** What to say when someone needs a token and has not got one yet. */
export const tokenGuide = (slash: string): string =>
  [
    `*1.* run \`${SETUP_COMMAND}\` in your terminal (needs the Claude Code CLI, and it opens a browser to log you in)`,
    "*2.* it prints a token starting with `sk-ant-oat01-`, copy the whole thing",
    `*3.* paste it into the box - the button below, or \`${slash} token\``,
  ].join("\n");

/** Why the bot is asking at all, in one line. */
export const tokenWhy = "reviews run on your own Claude Code account, so the usage lands on you and not on me";
