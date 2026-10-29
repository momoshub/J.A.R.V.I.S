/**
 * Writing a page into Notion.
 *
 * The gap this fills: asked for a runbook, the bot spent twenty minutes
 * producing a good one and then said "I can't write to Notion myself, so you'd
 * paste or import it there". That was half true in a way that made it useless.
 * Nothing DENIES writing to Notion - the tool policy only refuses the Slack
 * connector's posting tools - there was simply no command that did it, and the
 * chat prompt's blanket "you may never write through a connector" turned a
 * missing feature into a flat refusal.
 *
 * So this is the counterpart to `read`: the same host login, the same
 * connectors, one page out instead of one page in. It writes under the
 * authorising human's Notion identity, which is exactly why it is gated and
 * why it only ever creates what it was handed.
 */
import { SLACK_FORMAT } from "./slackFormat.ts";

export type NoteRequest = {
  /** Absolute path of the markdown file to publish. */
  readonly path: string;
  /** Title for the page; taken from the document when not given. */
  readonly title?: string;
  /** Notion url of the page or database the new page goes under. */
  readonly parent: string;
  readonly askedBy: string;
};

export const notePrompt = (req: NoteRequest, botName: string): string => `You are ${botName}, publishing a document into Notion for <@${req.askedBy}>.

The document: \`${req.path}\`
Where it goes: ${req.parent}
${req.title ? `Title: ${req.title}` : "Title: take it from the document's own first heading."}

You have the account's Notion connector in this session. It writes as the human who authorised it, so everything below is about not exceeding what you were asked to do.

How:
1. Read the file at that path, all of it. If it is not there, say so and stop - do not go looking for something that resembles it.
2. Create ONE page under the parent given above, with the Notion connector.
3. Carry the content across faithfully. Notion has real headings, tables, checklists and code blocks, so use them where the markdown does - this is a format change, not a rewrite.

What you must NOT do:
- do not summarise, shorten, reorganise or improve the document. You are publishing what you were handed. If it looks wrong, publish it and say so in your report
- do not create more than one page. Sub-pages only if the document itself is explicitly structured as a parent with children
- do not edit, move or delete any page that already exists. You create one new page, and nothing else
- do not post to Slack, send anything, or touch any other connector
- if the parent cannot be found or you cannot write there, STOP and say exactly that. Do not pick a different parent, and do not fall back to creating it somewhere else

Report back, briefly. Whatever you return is posted into the thread for you, so never apologise for being unable to post and never hand anyone text "ready to paste". ${SLACK_FORMAT}
- first line: the page url, and nothing else of substance
- then at most two lines: anything that did not carry across cleanly, or anything in the document that looked wrong to you
- do not describe the document back to whoever asked. They wrote it`;
