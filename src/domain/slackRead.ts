/**
 * Reading Slack with the bot's own token.
 *
 * A sandboxed role has no `curl`, deliberately: a general outbound request with
 * `SLACK_BOT_TOKEN` in the environment is an exfiltration channel. But the bot
 * genuinely can read these conversations - it is a member of most of them, and
 * public channels it can join - so a denied tool call is not the same thing as
 * a missing Slack permission.
 *
 * It had been reporting them as the same thing: handed a link to a public
 * channel, the `curl` was refused by the tool policy and the answer came back
 * as "I do not have permission to read that channel", which was false. The
 * narrow helper gives every role the door that its token already opens.
 *
 * The reads come back with names written in, because a bare id invites a
 * guess: summarising a thread it only saw \`U0ALEX00001\` in, the bot said
 * "Jordan" asked what Alex Example had asked.
 */

export const slackReadRules = (script?: string): string => {
  if (!script) return "";
  return `

Reading Slack conversations (your own token, every role):
- \`${script} history <channel> [limit] [latest-ts]\` - recent messages, or the one at a timestamp
- \`${script} replies <channel> <thread-ts> [limit]\` - a whole thread
- \`${script} info <channel>\` / \`${script} user <id>\` - what a channel or person is
- history and replies come back NAMED: each message has \`user_name\` and mentions read \`<@U…:name>\`. Name a person only from those. An id with no name next to it -> \`${script} user <id>\`, never a name from memory
- a Slack link \`/archives/<channel>/p<digits>\` gives you both ids: the channel, and the ts with a decimal point inserted before the last six digits
- a PUBLIC channel you have not joined is read by joining it first, which the helper does for you and announces. A PRIVATE one you were never invited to is genuinely closed - that is when the host-login \`read\` command is the answer
- this is your own token, so what you cannot read here, you cannot read. Never report a tool you were denied as a permission Slack refused you: say which call failed and what it said`;
};
