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
