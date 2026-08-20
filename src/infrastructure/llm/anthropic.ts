/**
 * Anthropic adapter - the concrete `LlmPort` that gives E.V. her voice.
 *
 * Thin on purpose: map our neutral prompt shape onto the SDK, call it, and pull
 * the text back out. All prompt-building lives in the domain layer.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { LlmPort } from "../../application/ports.ts";

export type AnthropicConfig = {
  apiKey: string;
  model: string;
  maxTokens?: number;
};

export const createAnthropicLlm = (config: AnthropicConfig): LlmPort => {
  const client = new Anthropic({ apiKey: config.apiKey });
  const maxTokens = config.maxTokens ?? 1024;

  return {
    complete: async ({ system, messages }) => {
      const response = await client.messages.create({
        model: config.model,
        max_tokens: maxTokens,
        system,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      });

      return response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
    },
  };
};
