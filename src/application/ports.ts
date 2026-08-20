/**
 * Application ports - the seams the use cases depend on.
 *
 * Concrete adapters (Anthropic, the system clock) live in infrastructure and are
 * injected at the composition root. Use cases only ever see these shapes, which
 * keeps them pure enough to test with fakes.
 */
import type { PromptMessage } from "../domain/types.ts";

/** Anything that can turn a system prompt + history into a reply. */
export type LlmPort = {
  complete: (params: {
    system: string;
    messages: readonly PromptMessage[];
  }) => Promise<string>;
};

/** Injectable clock so time-dependent logic stays deterministic in tests. */
export type Clock = () => number;
