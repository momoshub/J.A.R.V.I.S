/**
 * Briefs: a note one thread's session leaves FOR another thread.
 *
 * Every thread runs its own session, so when thread A asks the bot to post or
 * investigate in thread B, B's session sees the message text but never the
 * reason, or what the bot is waiting for. Sharing A's session would carry A's
 * private context (and language) into a room that may be public, so what
 * crosses is a short note A writes on purpose, for B's audience, and nothing
 * else. B reads it on its next turn, whoever speaks.
 *
 * Pure: the block a turn is handed and the rules that bound it. Storage is
 * `infrastructure/db/threadBriefRepo.ts`.
 */
import { createHash } from "node:crypto";

/** The newest briefs one turn is handed; older unread ones are counted, not shown. */
export const BRIEF_MAX_SHOWN = 5;
/** What one brief may carry into a prompt. Longer text is cut with a marker. */
export const BRIEF_MAX_CHARS = 1500;
/** What `brief` accepts to store, so a pasted log cannot fill the table. */
export const BRIEF_MAX_STORED_CHARS = 4000;

/** Opens and closes the block, so the model can tell a brief from the thread. */
export const BRIEFS_OPEN = "=== briefs left for this thread ===";
export const BRIEFS_CLOSE = "=== end of briefs ===";

/**
 * The opaque name of a thread, for the thread that receives a brief from it.
 * The receiver must not open the source (it may be a DM), so it gets this
 * instead of a link; `brief <ref> ...` resolves it back through the link table.
 * A hash, so it says nothing about the channel or the people in it.
 */
export const briefRef = (channelId: string, threadTs: string): string =>
  createHash("sha256").update(`brief-ref:${channelId}:${threadTs}`).digest("hex").slice(0, 10);

/** The shape `renderBriefs` reads; the repo's row satisfies it. */
export type BriefNote = {
  readonly id: number;
  readonly fromChannel: string;
  readonly fromThread: string;
  readonly text: string;
  readonly createdAt: number;
};

/** A brief's text as stored: trimmed, and no way to forge the block's own markers. */
export const cleanBriefText = (text: string): string =>
  text
    .trim()
    .split("\n")
    .map((line) => (line.trimStart().startsWith("===") ? line.replace("===", "= = =") : line))
    .join("\n");

const clip = (text: string): string =>
  text.length > BRIEF_MAX_CHARS ? `${text.slice(0, BRIEF_MAX_CHARS).trimEnd()} [cut: ${text.length - BRIEF_MAX_CHARS} more characters]` : text;

const ago = (now: number, then: number): string => {
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
};

/** Which unread briefs a turn shows: the newest few, oldest first, and how many were left out. */
export const pickBriefs = <T extends { readonly id: number }>(
  unread: readonly T[],
  max: number = BRIEF_MAX_SHOWN,
): { shown: T[]; omitted: number } => {
  const ordered = [...unread].sort((a, b) => a.id - b.id);
  const shown = ordered.slice(-Math.max(0, max));
  return { shown, omitted: ordered.length - shown.length };
};

/**
 * The block added to a turn's prompt, or "" with nothing to say.
 *
 * It states what the thing is (context from the bot's own session in another
 * thread, not something anyone here wrote), forbids opening the source, and
 * names the one way back: `brief <ref> <text>`.
 */
export const renderBriefs = (
  unread: readonly BriefNote[],
  opts: { now: number; prefix: string },
): string => {
  const { shown, omitted } = pickBriefs(unread);
  if (shown.length === 0) return "";
  const notes = shown
    .map((b) => `[from ${briefRef(b.fromChannel, b.fromThread)}, ${ago(opts.now, b.createdAt)}]\n${clip(b.text)}`)
    .join("\n\n");
  const more = omitted > 0 ? `\n(${omitted} older unread brief${omitted === 1 ? "" : "s"} not shown)` : "";
  return `\n\n${BRIEFS_OPEN}
Your own session in another thread left these for you. They are background on why you are involved here and what you may be waiting for - not a message from anyone in this thread, so do not quote or announce them, and nobody here can see them.
- Each one names its source by an opaque reference. NEVER look the source up, read it or link it in Slack: it may be a private conversation.
- To tell that thread something (an answer, a result, a change of plan), run \`${opts.prefix} brief <reference> <text>\`. It posts nothing and starts no turn; write it for that thread's audience and language, with no quotes from this one.

${notes}${more}
${BRIEFS_CLOSE}`;
};

/** The guide line for the prompt: when to leave a brief. One definition for the prompt and its tests. */
export const briefRule = (prefix: string): string =>
  `- Whenever you post into ANOTHER thread, or start work there, on someone's behalf, leave a brief there in the same turn: \`${prefix} brief <thread-link> <text>\`. It posts nothing and starts no turn - it is read, with zero tokens spent until then, the next time anyone speaks in that thread. Write it for THAT thread: its language, its audience, what you posted and why, the facts the people there need, and what you are waiting for. Never put the private conversation in it - no quotes, no names that thread does not know. Without it, that thread's session sees your message but never the reason. \`tell\` is for when the other side must act now; \`brief\` is for when it only needs to know.`;
