/**
 * Draft a Slack reply with the bot's brain - the AI-reply feature of the console.
 * Builds the same in-character system prompt used for live chat, feeds the thread
 * as context, and returns a plain draft for the human to review before posting.
 */
import { buildSystemPrompt } from "../domain/personality.ts";
import type { PromptContext, PromptMessage } from "../domain/types.ts";
import type { LlmPort } from "./ports.ts";
import type { SlackMessage } from "./slackAdmin.ts";

export type DraftReplyDeps = {
  llm: LlmPort;
  promptContext: () => PromptContext;
  /** The console is the owner's own tool, so its drafts are billed to the owner. */
  ownerSlackId: string;
};

export type DraftReply = (thread: readonly SlackMessage[], channel?: string) => Promise<string>;

export const createDraftReply = (deps: DraftReplyDeps): DraftReply => {
  return async (thread, channel) => {
    const ctx = deps.promptContext();
    const botName = ctx.botName ?? "You";
    const system = buildSystemPrompt({ botName: ctx.botName, base: ctx.base, learnings: ctx.learnings });
    const transcript = thread
      .filter((m) => m.text.trim())
      .map((m) => `${m.own ? botName : m.userName}: ${m.text}`)
      .join("\n");
    const content = [
      "Below is a Slack conversation. Draft a natural reply, in character, to continue it.",
      "Output only the reply text - no preamble, no surrounding quotes.",
      "",
      transcript || "(no messages yet)",
    ].join("\n");
    const messages: PromptMessage[] = [{ role: "user", content }];
    const bill = { actor: deps.ownerSlackId, kind: "draft", ...(channel ? { channel } : {}) };
    return (await deps.llm.complete({ system, messages, assistantName: ctx.botName, bill })).trim();
  };
};
