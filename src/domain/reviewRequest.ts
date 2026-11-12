/**
 * Asking for a quick PR review in plain words.
 *
 * `quick-review <url>` typed with the command prefix runs the command; the same
 * thing said to the bot as a mention used to go to the chat brain, which would
 * talk about the review instead of running one - and, once reviews needed the
 * caller's own token, explain the token instead of offering the box that takes
 * it. The person asking cannot tell the two paths apart, so this closes the gap.
 *
 * Deliberately narrow, because a review spends the asker's own credential and
 * must never start by itself: the message has to open with the mention (the bot
 * was spoken to), the first word after it has to be `review` or `approve` (both
 * mean the same quick review - there is no approval without one), and it has to
 * carry a real pull request url. Anything vaguer stays a conversation.
 *
 * Whether a turn may use this at all is `respond`'s call: only a message a
 * human tagged the bot in, never a turn the bot started itself, a followed
 * thread's untagged reply, a batch, or a thread driving a workflow.
 */

const PR_URL = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
/** The mention(s) the message opens with: `<@U1>`, `<@U1|name>` or `<@U1:Name>`. */
const LEADING_MENTIONS = /^(\s*<@[^>]+>)+\s*/;
/** `review <pr>` or `approve <pr>` right after the mention. Not "reviewer", not "reviewing". */
const VERB = /^(review|approve)\b/i;
/** Command flags said out loud, e.g. "@bot review <url> --policy after". */
const FLAGS = /--policy[= ][\w-]+|policy:[\w-]+|--first\b|--after\b/gi;

/**
 * The command line this message is really asking for, or undefined when it is
 * just talk. Urls are returned bare, in the order they appeared, deduplicated -
 * Slack wraps them as `<url|label>`, which the command would otherwise re-parse.
 */
export const reviewRequestIn = (text: string): string | undefined => {
  if (!text) return undefined;
  const mention = LEADING_MENTIONS.exec(text);
  if (!mention) return undefined;
  const spoken = text.slice(mention[0].length);
  if (!VERB.test(spoken)) return undefined;
  const urls = [...new Set(spoken.match(PR_URL) ?? [])];
  if (urls.length === 0) return undefined;
  // Flags carry through, so a spoken request can still say how to run: the rest
  // of the sentence does not, because "can you please" is not guidance and
  // guessing which half of a sentence was meant as instruction is worse than
  // not trying. Typed with the prefix, the free text is the steering note.
  return `quick-review ${[...urls, ...(spoken.match(FLAGS) ?? [])].join(" ")}`;
};
