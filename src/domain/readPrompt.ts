/**
 * Reading a conversation the bot's own token cannot see.
 *
 * The bot talks with its own Slack token, which is the right default: everything
 * it says arrives under its own name. But that token only sees what the bot has
 * been invited to, so a channel or group DM it is not a member of returns
 * `channel_not_found` and the answer is "add me first".
 *
 * The account's Slack connector can read those, with the access of the human who
 * authorised it. That is a genuinely different capability, not a workaround:
 * reading impersonates nobody. WRITING through the connector does - a message
 * would arrive under that human's name - which is why the write tools stay
 * denied everywhere and this task only ever reads.
 *
 * It runs on the host login, because a `claude setup-token` credential carries
 * no connector authorisation at all.
 */

import { SLACK_FORMAT } from "./slackFormat.ts";

export type ReadRequest = {
  /** What to read: a Slack permalink, a channel reference, or a description. */
  target: string;
  /** What the person actually wants out of it, if they said. */
  note?: string;
  /** Where the answer goes. */
  channelId: string;
  threadTs?: string;
  askedBy: string;
};

/** One line for the chat prompt, so the brain escalates instead of refusing. */
export const readChatRules = (prefix: string): string => `

Reading a channel or DM you are not in:
- your own token only sees what you have been invited to. \`channel_not_found\` means exactly that, and it is not a reason to give up
- \`${prefix} read <link or #channel>\` reads it through the account's Slack connector, which sees what the authorising human sees. Run it yourself through the run helper rather than telling someone to type it
- it is owner-only, so for anyone else the honest answer is still "add me to that conversation, or paste it here"
- you may READ that way. You may never POST that way: a message sent through the connector arrives under a human's name instead of yours, which is why those tools are denied to you everywhere`;

export const readPrompt = (req: ReadRequest, botName: string): string => {
  const wanted = req.note?.trim()
    ? `What they want from it, in their words:\n"""\n${req.note.trim()}\n"""`
    : "No particular angle was given, so summarise it: what it is about, what was decided, what is still open, and anything that needs someone.";

  return `You are ${botName}, reading a Slack conversation for <@${req.askedBy}> and reporting back.

Read this:
"""
${req.target}
"""

${wanted}

You have the account's Slack connector in this session, which sees what the authorising human sees - including channels and group DMs your own bot token was never invited to. That is why this runs as its own job.

How:
1. Resolve what you were given. A permalink carries the channel id and the message ts (\`/archives/<channel>/p<ts>\`, where the ts needs a decimal point inserted before the last six digits). A \`#channel\` reference needs looking up by name.
2. Read it with the connector's READ tools - the thread, or the channel's recent history. Follow the thread the link points at, not just the single message.
3. If it is long, read enough to be accurate rather than everything: the opening, the decisions, the last exchanges.

Rules that are not negotiable:
- READ only. Never send, schedule, draft or edit anything through the connector, and never post into the conversation you are reading. Your report goes back to the thread you were asked from, through your own token, under your own name
- never invent a quote, a name or a timestamp. If you could not read something, say which part and why
- \`channel_not_found\` through the connector too means the authorising human is not in it either. Say so plainly - that is a real answer, not a failure

Reporting back:

${SLACK_FORMAT}
- lead with what the conversation is actually about, in one line
- then the substance as short bullets: what was decided, what is blocked, who owes what
- name people as <@U123> when you have their id, never a bare display name
- say what you could not see. A summary that quietly omits the half you could not read is worse than one that admits it
- keep it to what someone needs to catch up, not a transcript`;
};
