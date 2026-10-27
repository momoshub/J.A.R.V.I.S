/**
 * How to write a message that Slack will actually render.
 *
 * Slack does not use Markdown. It uses mrkdwn, which overlaps just enough to be
 * a trap: `**bold**` renders as literal asterisks, `[label](url)` renders as
 * literal brackets, and `#` headings render as a hash. A model reaching for
 * Markdown by default produces a message that reads like source code, which is
 * exactly what it looks like in a channel.
 *
 * Shared by every prompt that produces Slack text, so there is one definition
 * of the format rather than a slightly different one in each.
 */

export const SLACK_FORMAT = `Writing for Slack (it is mrkdwn, NOT Markdown - these are different):
- bold is *one asterisk*, never **two**. Italic is _underscores_. Strikethrough is ~tildes~
- a link is <https://example.com|the label>, never [the label](https://example.com)
- there are no headings. A line starting with # renders as a literal #. If you need a heading, make it a short bold line
- there are no tables. Use short lines, or a bulleted list
- \`inline code\` and \`\`\`code blocks\`\`\` work, and are the right way to show an id, a path, a query or an error
- bullets are "- " at the start of a line; > quotes a line
- mention people as <@U123>, channels as <#C123>. A bare @name notifies nobody
- no em dashes or en dashes; a plain hyphen, a comma or a new sentence reads better anyway`;

/**
 * Length discipline. Separate from the syntax rules because it is the other
 * half of the same problem: a correctly formatted wall of text is still a wall
 * of text, and most of these messages are read on a phone.
 */
export const SLACK_BREVITY = `Length:
- most replies are one to three short lines. If you are writing a fourth, ask what the reader actually needs
- lead with the answer or the outcome. Context, caveats and reasoning come after it, if at all
- never restate what the person just said back to them, and never narrate what you are about to do
- a link plus one line beats a paragraph describing what is behind the link
- when there is genuinely a lot to say, say the short version and offer the rest: people can ask`;

/**
 * Rewrite Markdown that slipped through into the mrkdwn Slack actually renders.
 *
 * `SLACK_FORMAT` tells every prompt the rules, and models still reach for
 * Markdown - a long relayed answer is where the habit resurfaces. The result is
 * a message full of literal `**` and `[label](url)`, which is the one thing the
 * reader sees. A rule the model may ignore is not a guarantee; a conversion at
 * the boundary is.
 *
 * Conservative on purpose. It only touches constructs that cannot render in
 * Slack at all, and never looks inside code: a fenced block or an inline span
 * is held out and put back untouched, because `**ptr` in a C snippet is code,
 * not emphasis.
 */
export const toMrkdwn = (text: string): string => {
  if (!text) return text;

  // Hold out code first, so nothing below can reach inside it.
  const held: string[] = [];
  const stash = (s: string): string => {
    held.push(s);
    return `\u0000${held.length - 1}\u0000`;
  };
  let out = text
    .replace(/```[\s\S]*?```/g, stash)
    .replace(/`[^`\n]*`/g, stash);

  out = out
    // **bold** / __bold__ -> *bold*. Non-greedy, and never across a blank line,
    // so an unpaired marker cannot swallow the rest of the message.
    .replace(/\*\*(?!\s)([^\n]*?[^\s*])\*\*/g, "*$1*")
    .replace(/__(?!\s)([^\n]*?[^\s_])__/g, "*$1*")
    // [label](url) -> <url|label>
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>")
    // headings -> a short bold line, which is what Slack leaves you
    .replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, "*$1*")
    // * bullet and + bullet -> "- ", the one Slack renders. Only at line start,
    // and only with a space after, so it cannot catch *bold* at the margin.
    .replace(/^([ \t]*)[*+][ \t]+/gm, "$1- ");

  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => held[Number(i)] ?? "");
};

/**
 * Slack refuses a section block whose text is over 3000 characters, and refuses
 * the whole message with it. A command list grows a line at a time and would
 * cross that quietly, so long text is split across several sections instead.
 *
 * Splits on line boundaries, because the text is a list and a section that ends
 * mid-entry reads like a bug. A single line longer than the limit is passed
 * through whole rather than cut - Slack's own truncation is better than silently
 * losing half of something.
 */
export const SECTION_LIMIT = 2900;

export const splitForBlocks = (text: string, limit = SECTION_LIMIT): string[] => {
  if (text.length <= limit) return text.trim() ? [text] : [];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
};
