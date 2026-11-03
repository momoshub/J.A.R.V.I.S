/**
 * What a Slack message actually SAYS, as opposed to what the API hands back.
 *
 * A message the bot streamed into is built from blocks: a `task_card` per tool
 * call, then the rich text of the reply. Slack also stores a flattened `text`
 * for notifications and search, and that fallback is every block's text run
 * together - so a streamed reply's `text` begins with the bot's own tool calls:
 *
 *   "🐦‍🔥 run: cd /repo && sqlite3 data/bot.db ... Nói thật thì em gần như..."
 *
 * In Slack itself this is invisible; the cards render as a timeline above the
 * answer. It only surfaces when the bot READS a conversation back - the `reply`
 * and `summarise` commands, the draft path, the read helper - and there it is
 * genuinely damaging: the bot ingests its own shell commands as though they
 * were sentences it had written, and reasons about them. Asked what it was bad
 * at, it read this thread back, saw `run: cd ... && sqlite3` at the head of its
 * own messages, and reported a leak in its replies that nobody in Slack can
 * see. A false bug report about itself, from reading its own fallback text.
 *
 * So the cards are taken back out. The titles are removed in block order, each
 * one cut at its first occurrence at or after the previous cut, because that is
 * exactly how the fallback was assembled.
 */

/** The parts of a Slack block we care about; everything else is ignored. */
export type MessageBlock = {
  readonly type?: string;
  readonly title?: string;
};

export type RenderedMessage = {
  readonly text?: string;
  readonly blocks?: readonly MessageBlock[];
};

/** Titles of the tool cards on a message, in the order Slack flattened them. */
export const taskCardTitles = (blocks: readonly MessageBlock[] = []): string[] =>
  blocks.filter((b) => b.type === "task_card").map((b) => (b.title ?? "").trim()).filter(Boolean);

/**
 * The message's text with its tool-card titles removed.
 *
 * A message with no cards comes back untouched, and a message that was NOTHING
 * but cards comes back empty - which is the truth: it said nothing.
 */
export const visibleText = (message: RenderedMessage): string => {
  const text = message.text ?? "";
  const titles = taskCardTitles(message.blocks);
  if (titles.length === 0 || !text) return text;
  let out = text;
  let from = 0;
  for (const title of titles) {
    const at = out.indexOf(title, from);
    if (at === -1) continue; // not in the fallback (clipped, or rendered differently)
    // Slack joined the blocks with a single space; take that joint away with
    // the title rather than collapsing whitespace globally afterwards, which
    // would flatten the indentation of an ascii diagram it really did post.
    const end = at + title.length;
    const trailingSpace = out[end] === " ";
    const leadingSpace = !trailingSpace && at > 0 && out[at - 1] === " ";
    const start = leadingSpace ? at - 1 : at;
    out = out.slice(0, start) + out.slice(trailingSpace ? end + 1 : end);
    from = start;
  }
  return out.trim();
};
