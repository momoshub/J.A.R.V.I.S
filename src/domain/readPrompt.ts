/**
 * Reading something the bot's own credentials cannot see.
 *
 * The bot talks with its own Slack token, which is the right default: everything
 * it says arrives under its own name. But that token only sees what the bot has
 * been invited to, so a channel or group DM it is not a member of returns
 * `channel_not_found` and the answer is "add me first".
 *
 * The account's connectors - Slack, Notion, whatever else is authorised - can
 * read those, with the access of the human who authorised them. That is a genuinely different capability, not a workaround:
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

You have the account's connectors in this session - Slack, Notion and whatever else the account has authorised - and they see what the authorising human sees, including pages and conversations your own bot token cannot touch. That is the whole reason this runs as its own job.

How:
1. Resolve what you were given, whatever kind of thing it is.
   - a Slack permalink carries the channel id and the message ts (\`/archives/<channel>/p<ts>\`, where the ts needs a decimal point inserted before the last six digits); a \`#channel\` reference needs looking up by name
   - a Notion url carries the page id as the trailing 32 hex characters; fetch it with the Notion connector
   - a link may lead to both: a Slack message whose point is the document it links to. Follow it. Summarising "Paul posted a link" when the link is the content is not an answer
2. Read it with the connectors' READ tools. Follow the thread or page the link points at, not just the one message, and open what it links to when that is plainly the substance.
3. If it is long, read enough to be accurate rather than everything: the opening, the decisions, the last exchanges, the acceptance criteria.
4. NEVER hand-roll a request to a private service's internal API - a raw \`curl\` to notion.so or an endpoint your token has no scope for. It returns an empty body, and an empty body is not evidence that something is private.

Rules that are not negotiable:
- READ only. Never send, schedule, draft or edit anything through the connector, and never post into the conversation you are reading. Your report goes back to the thread you were asked from, through your own token, under your own name
- never invent a quote, a name or a timestamp. If you could not read something, say which part and why
- if the connector cannot reach it either, the authorising human has no access to it either. Say so plainly, naming what you tried - that is a real answer, not a failure. "It is private" after one unauthenticated guess is not

Reporting back:

${SLACK_FORMAT}
- lead with what the conversation is actually about, in one line
- then the substance as short bullets: what was decided, what is blocked, who owes what
- name people as <@U123> when you have their id, never a bare display name
- say what you could not see. A summary that quietly omits the half you could not read is worse than one that admits it
- keep it to what someone needs to catch up, not a transcript`;
};
