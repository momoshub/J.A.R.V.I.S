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
 * authorising human's Notion identity, which is why it is gated and why it
 * never does more than it was asked.
 *
 * It used to CREATE and nothing else - "do not edit, move or delete any page
 * that already exists" was in this prompt in those words. That was the narrow
 * safe thing to build first, and over time it became the complaint: asked to
 * update a document, it published a second copy of it, so the team ended up
 * with two runbooks and no way to tell which one was real. A document that
 * silently forks is worse than one nobody can edit.
 *
 * Updating is therefore a MODE, chosen by the caller, never inferred. Each
 * mode forbids the others: a create may not touch an existing page, and an
 * update may not create one when the page it was given cannot be found - which
 * is the failure that produced the duplicates in the first place.
 */
import { SLACK_FORMAT } from "./slackFormat.ts";
import type { NoteMode } from "./noteTarget.ts";

export type NoteRequest = {
  /** Absolute path of the markdown file to publish. */
  readonly path: string;
  /** Title for the page; taken from the document when not given. */
  readonly title?: string;
  /** Notion url of the page or database a NEW page goes under. */
  readonly parent: string;
  readonly askedBy: string;
  /** Create a page, replace an existing one's body, or add to its end. */
  readonly mode?: NoteMode;
  /** The page being edited. Required by `replace` and `append`. */
  readonly target?: string;
};

/** What each mode is allowed to do, and what it must refuse. */
const PLAN: Record<NoteMode, (req: NoteRequest) => string> = {
  create: (req) => `Where it goes: ${req.parent}

How:
1. Read the file at that path, all of it. If it is not there, say so and stop - do not go looking for something that resembles it.
2. Create ONE page under the parent given above, with the Notion connector.
3. Carry the content across faithfully. Notion has real headings, tables, checklists and code blocks, so use them where the markdown does - this is a format change, not a rewrite.

What you must NOT do:
- do not create more than one page. Sub-pages only if the document itself is explicitly structured as a parent with children
- do not edit, move or delete any page that already exists. This run creates one new page, and nothing else
- if the parent cannot be found or you cannot write there, STOP and say exactly that. Do not pick a different parent, and do not fall back to creating it somewhere else`,

  replace: (req) => `The page to update: ${req.target}

How:
1. Read the file at that path, all of it. If it is not there, say so and stop.
2. Open ${req.target} and read what is there NOW, before you change anything. You need it to report what you replaced, and to notice if you have been handed the wrong page.
3. Replace that page's body with the document. Same page, same url, same comments and backlinks - this is an edit, not a republish.${req.title ? "" : " Leave the page's title alone unless the document's own heading plainly supersedes it."}
4. Carry the content across faithfully, using Notion's real headings, tables, checklists and code blocks.

What you must NOT do:
- do NOT create a new page. Not as a draft, not as a copy, not "to be safe". If ${req.target} cannot be opened or cannot be written to, STOP and say exactly that - a second copy of a document is the specific failure this mode exists to end
- do not touch any page other than that one
- do not keep the old content alongside the new. Replacing means replacing; if something in the old page should survive and is missing from the document, do not quietly merge it - say so in your report and let them decide`,

  append: (req) => `The page to add to: ${req.target}

How:
1. Read the file at that path, all of it. If it is not there, say so and stop.
2. Open ${req.target} and read it, so that what you add follows on from what is there rather than repeating it.
3. Add the document to the END of that page. Everything already on it stays exactly as it is.
4. Carry the content across faithfully, using Notion's real headings, tables, checklists and code blocks.

What you must NOT do:
- do NOT create a new page. If ${req.target} cannot be opened or written to, STOP and say so
- do not edit, reorder or tidy anything that was already on the page. You are adding to the end of it, nothing more
- do not touch any page other than that one`,
};

const VERB: Record<NoteMode, string> = {
  create: "publishing a document into Notion",
  replace: "updating a document in Notion",
  append: "adding to a document in Notion",
};

export const notePrompt = (req: NoteRequest, botName: string): string => {
  const mode = req.mode ?? "create";
  return `You are ${botName}, ${VERB[mode]} for <@${req.askedBy}>.

The document: \`${req.path}\`
${req.title ? `Title: ${req.title}` : mode === "create" ? "Title: take it from the document's own first heading." : ""}
You have the account's Notion connector in this session. It writes as the human who authorised it, so everything below is about not exceeding what you were asked to do.

${PLAN[mode](req)}
- do not summarise, shorten, reorganise or improve the document. You are publishing what you were handed. If it looks wrong, publish it and say so in your report
- do not post to Slack, send anything, or touch any other connector

Report back, briefly. Whatever you return is posted into the thread for you, so never apologise for being unable to post and never hand anyone text "ready to paste". ${SLACK_FORMAT}
- first line: the page url, and nothing else of substance${mode === "create" ? "" : " - the page you edited, not a new one"}
- then at most two lines: anything that did not carry across cleanly, or anything in the document that looked wrong to you${mode === "replace" ? ", and anything that was on the page before and is not in the document" : ""}
- do not describe the document back to whoever asked. They wrote it`;
};
