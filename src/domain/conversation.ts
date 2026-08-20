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

/**
 * Build the ordered prompt window from stored history.
 *
 * History is expected oldest-first. We keep the last `windowSize` turns so the
 * most recent context always survives.
 */
export const buildContextWindow = (
  history: readonly StoredMessage[],
  windowSize: number = DEFAULT_CONTEXT_WINDOW,
): PromptMessage[] => {
  const size = Math.max(0, Math.floor(windowSize));
  return history
    .slice(-size)
    .map(({ role, content, slackUserId }) => ({ role, content, speakerId: slackUserId }));
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
