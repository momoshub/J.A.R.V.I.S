/**
 * Asking for a PR review in plain words.
 *
 * `review <url>` typed with the command prefix runs the command; the same thing
 * said to the bot as a mention used to go to the chat brain, which would talk
 * about the review instead of running one - and, once reviews needed the
 * caller's own token, explain the token instead of offering the box that takes
 * it. The person asking cannot tell the two paths apart, so this closes the gap.
 *
 * Deliberately narrow: the bot has to have been spoken to, the message has to
 * carry a real pull request url, and it has to actually say "review". Anything
 * vaguer stays a conversation, because running a review is not free - it spends
 * the asker's own credential.
 */

const PR_URL = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
/** "review", "reviews", "reviewing", "reviewed", "re-review". Not "reviewer". */
const ASKS = /\b(re-?)?review(s|ing|ed)?\b/i;

/**
 * The command line this message is really asking for, or undefined when it is
 * just talk. Urls are returned bare, in the order they appeared, deduplicated -
 * Slack wraps them as `<url|label>`, which the command would otherwise re-parse.
 */
export const reviewRequestIn = (text: string): string | undefined => {
  if (!text || !ASKS.test(text)) return undefined;
  const urls = [...new Set(text.match(PR_URL) ?? [])];
  return urls.length > 0 ? `review ${urls.join(" ")}` : undefined;
};
