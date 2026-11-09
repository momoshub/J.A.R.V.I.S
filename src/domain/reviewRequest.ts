/**
 * Asking for a PR review in plain words.
 *
 * `review <url>` typed with the command prefix runs the command; the same thing
 * said to the bot as a mention used to go to the chat brain, which would talk
 * about the review instead of running one - and, back when reviews needed the
 * caller's own token, explain the token instead of running. The person asking cannot tell the two paths apart, so this closes the gap.
 *
 * Deliberately narrow: the bot has to have been spoken to, the message has to
 * carry a real pull request url, and it has to actually say "review". Anything
 * vaguer stays a conversation, because running a review is not free - it spends
 * the asker's credential (or the bot's, with none on file).
 */

const PR_URL = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
/** "review", "reviews", "reviewing", "reviewed", "re-review". Not "reviewer". */
const ASKS = /\b(re-?)?review(s|ing|ed)?\b/i;
/** Command flags said out loud, e.g. "@bot review <url> --policy after". */
const FLAGS = /--policy[= ][\w-]+|policy:[\w-]+|--first\b|--after\b/gi;

/**
 * The command line this message is really asking for, or undefined when it is
 * just talk. Urls are returned bare, in the order they appeared, deduplicated -
 * Slack wraps them as `<url|label>`, which the command would otherwise re-parse.
 */
export const reviewRequestIn = (text: string): string | undefined => {
  if (!text || !ASKS.test(text)) return undefined;
  const urls = [...new Set(text.match(PR_URL) ?? [])];
  if (urls.length === 0) return undefined;
  // Flags carry through, so a spoken request can still say how to run: the rest
  // of the sentence does not, because "can you please" is not guidance and
  // guessing which half of a sentence was meant as instruction is worse than
  // not trying. Typed with the prefix, the free text is the steering note.
  return `review ${[...urls, ...(text.match(FLAGS) ?? [])].join(" ")}`;
};
