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
  /** Absolute path of the artifact helper; without it, artifacts stay closed. */
  artifactScript?: string;
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
    ? `Why you were sent, in their words:\n"""\n${req.note.trim()}\n"""\nAnswer THAT. Read whatever you must to answer it well, then report only what bears on it.`
    : "No angle was given, so answer the obvious question: what is this, what does it decide, what is still open, what needs someone. Briefly - the point is to save them opening it, not to reproduce it.";

  return `You are ${botName}, reading a Slack conversation for <@${req.askedBy}> and reporting back.

Read this:
"""
${req.target}
"""

${wanted}

You have the account's connectors in this session - Slack, Notion, Google Drive and Docs, Calendar, Gmail, and whatever else the account has authorised - and they see what the authorising human sees, including pages and conversations your own bot token cannot touch. That is the whole reason this runs as its own job.

How:
1. Resolve what you were given, whatever kind of thing it is.
   - a Slack permalink carries the channel id and the message ts (\`/archives/<channel>/p<ts>\`, where the ts needs a decimal point inserted before the last six digits); a \`#channel\` reference needs looking up by name
   - a Notion url carries the page id as the trailing 32 hex characters; fetch it with the Notion connector
   - Google is here too: Docs, Drive, Sheets, Slides, Calendar and Gmail. Meeting notes usually live there as Drive documents titled "<meeting> - Notes by Gemini", so a request for "what we decided in standup" is a Drive SEARCH, not a missing link. You were given a description rather than a url - find it, say which document answered you, and link it
${
    req.artifactScript
      ? `   - a \`claude.ai/artifact/...\` link is a Claude artifact. You cannot read it with the connectors and you cannot fetch it over the web; run this instead, which can:
       ${req.artifactScript} '<the whole url, share key and all>'
     It prints the artifact's content. Give it up to three minutes - it opens a session of its own to do the work.`
      : `   - a \`claude.ai/artifact/...\` link is a Claude artifact, and nothing here can open one. Say so, and offer the way forward: paste the content, or publish it as a Claude *Doc*, which the connector CAN read.`
  }
   - NEVER fetch an artifact url over the web, whatever else you try. It returns a placeholder shell titled "Claude Artifact" with no content, on every artifact, shared or not - so an empty page there proves nothing at all
   - and never ask anyone to re-share an artifact with the host account. It is usually already shared, and sending someone off to re-share what they already shared is worse than saying plainly that you could not open it
   - a link may lead to both: a Slack message whose point is the document it links to. Follow it. Summarising "Paul posted a link" when the link is the content is not an answer
2. Read it with the connectors' READ tools. Follow the thread or page the link points at, not just the one message, and open what it links to when that is plainly the substance.
3. If it is long, read enough to be accurate rather than everything: the opening, the decisions, the last exchanges, the acceptance criteria.
4. NEVER hand-roll a request to a private service's internal API - a raw \`curl\` to notion.so or an endpoint your token has no scope for. It returns an empty body, and an empty body is not evidence that something is private.

Rules that are not negotiable:
- READ only. Never send, schedule, draft or edit anything through the connector, and never post into the conversation you are reading. Your report goes back to the thread you were asked from, through your own token, under your own name
- never invent a quote, a name or a timestamp. If you could not read something, say which part and why
- if the connector cannot reach it either, the authorising human has no access to it either. Say so plainly, naming what you tried - that is a real answer, not a failure. "It is private" after one unauthenticated guess is not

Reporting back. You are ANSWERING A QUESTION, not mirroring a page:

${SLACK_FORMAT}
- the first line answers why you were sent. If someone asked which pod owns a scope, name the pod. If they asked you to follow a handbook, say what the handbook tells them to do - or that it does not say. Everything else is support for that line
- then at most a handful of bullets: only what bears on the question
- **fifteen lines is the ceiling**, and most reads need far fewer. If you are reaching for a second message, you have stopped answering and started transcribing. Say the rest exists and offer it: "it also covers X, Y and Z - say the word"
- never reproduce the source. Nobody asked for the page back; they can open it. What they cannot do is the reading, the judgement and the part where you say what it means for them
- it is somebody else's thread. Every line you add is read by everyone in it, including people who did not ask and are following their own issue
- name people as <@U123> when you have their id, never a bare display name
- say what you could not see, and say when the page does NOT answer the question. "The handbook has no procedure for this" is a complete and valuable answer; burying it under everything the page does say is not`;
};
