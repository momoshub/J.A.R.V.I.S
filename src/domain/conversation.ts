/**
 * Pure conversation/context logic.
 *
 * Turns the bot's stored memory into the message list handed to the LLM, applying a
 * window so prompts stay bounded regardless of how long a channel has been
 * chatting.
 */
import type { PromptMessage, Reactable, StoredMessage } from "./types.ts";

/** Default number of most-recent turns to keep in the prompt window. */
export const DEFAULT_CONTEXT_WINDOW = 20;

/** Marks the attachments listed on a turn. One definition, used both to write
 * them and to make sure they survive the window. */
export const ATTACHMENT_MARKER = "[attached]";

const toPrompt = ({ role, content, slackUserId }: StoredMessage): PromptMessage => ({
  role,
  content,
  speakerId: slackUserId,
});

/**
 * Build the ordered prompt window from stored history, oldest-first.
 *
 * Taking the last N turns is wrong for a thread that has run long: the first
 * message is the subject, and whatever was shared in it - the screenshot the
 * whole thread is about - falls off the front exactly when the conversation
 * gets interesting. So the root is kept, and so are turns carrying an
 * attachment - but those get at most half the window, newest first, and the
 * newest turn is always kept. Attachments used to be taken oldest-first with no
 * cap: a long thread full of screenshots filled the whole window with them and
 * the message actually being answered fell out, so a cold session replied to
 * the thread's opening request instead. Order is preserved, so the newest turn
 * is still last.
 */
export const buildContextWindow = (
  history: readonly StoredMessage[],
  windowSize: number = DEFAULT_CONTEXT_WINDOW,
): PromptMessage[] => {
  const size = Math.max(0, Math.floor(windowSize));
  if (size === 0) return [];
  if (history.length <= size) return history.map(toPrompt);

  const last = history.length - 1;
  const keep = new Set<number>([last]); // what is being answered, always
  if (keep.size < size) keep.add(0); // the root: what the thread is about
  const attachmentCap = keep.size + Math.floor((size - keep.size) / 2);
  for (let i = last - 1; i > 0 && keep.size < attachmentCap; i--) {
    if (history[i]?.content.includes(ATTACHMENT_MARKER)) keep.add(i);
  }
  for (let i = last - 1; i > 0 && keep.size < size; i--) keep.add(i);

  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => toPrompt(history[i] as StoredMessage));
};

/** How many recent messages the bot is offered as reaction targets. */
export const DEFAULT_REACTABLE_LIMIT = 8;
const EXCERPT_CHARS = 80;

/**
 * The recent messages the bot could react to: human turns that we know the Slack
 * ts of, newest last. Its own turns are excluded (reacting to yourself is odd)
 * and so is anything stored before timestamps were kept.
 */
export const reactableMessages = (
  history: readonly StoredMessage[],
  limit: number = DEFAULT_REACTABLE_LIMIT,
): Reactable[] =>
  history
    .filter((m) => m.role === "user" && !!m.slackTs)
    .slice(-Math.max(0, Math.floor(limit)))
    .map((m) => ({
      ts: m.slackTs as string,
      speakerId: m.slackUserId,
      excerpt: m.content.length > EXCERPT_CHARS ? `${m.content.slice(0, EXCERPT_CHARS)}...` : m.content,
    }));

/**
 * Normalise inbound text for the prompt: collapse whitespace and trim. Mentions
 * are kept (they are annotated with names upstream so the model knows who is
 * referenced); use `hasContent` to decide whether a message is mention-only.
 */
export const cleanInboundText = (raw: string): string => raw.replace(/\s+/g, " ").trim();

/**
 * The thread as it stood when this message was sent: nothing after it.
 *
 * A queued turn reads the thread when it finally runs, not when it was asked.
 * By then the bot's own "still working on ... yours is next" notice sits under
 * the message, and so may later asks that are each getting a turn of their
 * own. Left in, the notice became "the newest message" and the turn answered
 * the bot's own status line instead of the person waiting on it.
 *
 * Unknown or missing ts leaves the thread alone; the caller appends the
 * trigger itself when Slack has not caught up with it yet.
 */
export const endAtTrigger = <T extends { readonly slackTs?: string }>(
  turns: readonly T[],
  triggerTs?: string,
): T[] => {
  if (!triggerTs) return [...turns];
  const at = turns.findIndex((t) => t.slackTs === triggerTs);
  return at < 0 ? [...turns] : turns.slice(0, at + 1);
};
