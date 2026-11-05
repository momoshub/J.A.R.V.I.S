/**
 * People the owner has turned away for good.
 *
 * They get a one-line answer instead of a request: no notice is raised, so
 * asking again costs the deciders nothing.
 *
 * It lives in settings rather than in the source because this codebase is
 * open: a list of Slack ids and a joke aimed at named colleagues is one
 * instance's private business, and `src/` is supposed to carry no
 * instance-specific identity at all. Same rule that keeps the bot's name, its
 * prefix and its database path out of here.
 */

/** `U1, U2` -> ["U1","U2"]. Tolerates spacing, mention syntax and blanks. */
export const parseSnubbed = (raw?: string): string[] => [
  ...new Set(
    (raw ?? "")
      .split(/[,\n]/)
      .map((s) => s.trim().replace(/^<@/, "").replace(/[|>].*$/, "").toUpperCase())
      .filter((s) => /^[A-Z0-9]{5,}$/.test(s)),
  ),
];

export const formatSnubbed = (ids: readonly string[]): string => ids.join(",");

export const isSnubbed = (ids: readonly string[], slackUserId: string): boolean =>
  ids.includes(slackUserId.toUpperCase());

/**
 * What a snubbed person is told. Configured, because the stock line should not
 * name anybody - an instance that sets nothing simply turns them away politely.
 */
export const DEFAULT_SNUB_REPLY = "I am not able to help you here, sorry.";
