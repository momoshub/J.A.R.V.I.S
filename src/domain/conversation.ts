/**
 * Pure conversation/context logic.
 *
 * Turns the bot's stored memory into the message list handed to the LLM, applying a
 * window so prompts stay bounded regardless of how long a channel has been
 * chatting.
 */
import type { PromptMessage, StoredMessage } from "./types.ts";

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

/**
 * Normalise inbound text for the prompt: collapse whitespace and trim. Mentions
 * are kept (they are annotated with names upstream so the model knows who is
 * referenced); use `hasContent` to decide whether a message is mention-only.
 */
export const cleanInboundText = (raw: string): string => raw.replace(/\s+/g, " ").trim();
