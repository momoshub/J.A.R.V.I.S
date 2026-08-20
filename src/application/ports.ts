/**
 * Application ports - the seams the use cases depend on.
 *
 * Concrete adapters (Anthropic, the system clock) live in infrastructure and are
 * injected at the composition root. Use cases only ever see these shapes, which
 * keeps them pure enough to test with fakes.
 */
import type { PromptMessage } from "../domain/types.ts";

/** An incremental event produced while the model is generating a reply. */
export type LlmStreamEvent =
  | { readonly type: "text"; readonly delta: string }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly title: string;
      readonly details?: string;
      readonly status: "in_progress" | "complete" | "error";
    };

/** Consumer of streaming events (e.g. the Slack streaming renderer). */
export type LlmStreamSink = (event: LlmStreamEvent) => void;

export type LlmCompleteParams = {
  readonly system: string;
  readonly messages: readonly PromptMessage[];
  /** Label for the bot's own turns in a rendered transcript. */
  readonly assistantName?: string;
};

/** Anything that can turn a system prompt + history into a reply. */
export type LlmPort = {
  /** One-shot: resolve with the full reply text. */
  complete: (params: LlmCompleteParams) => Promise<string>;
  /**
   * Optional streaming: emit deltas/tool events through `sink` as they arrive,
   * and resolve with the final reply text. Adapters without streaming omit this
   * and callers fall back to `complete`.
   */
  stream?: (params: LlmCompleteParams, sink: LlmStreamSink) => Promise<string>;
};

/** Injectable clock so time-dependent logic stays deterministic in tests. */
export type Clock = () => number;
