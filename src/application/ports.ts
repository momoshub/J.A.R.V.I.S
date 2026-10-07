/**
 * Application ports - the seams the use cases depend on.
 *
 * Concrete adapters (Anthropic, the system clock) live in infrastructure and are
 * injected at the composition root. Use cases only ever see these shapes, which
 * keeps them pure enough to test with fakes.
 */
import type { PromptMessage } from "../domain/types.ts";
import type { ToolPolicy } from "../domain/toolPolicy.ts";

/** An incremental event produced while the model is generating a reply. */
export type LlmStreamEvent =
  | { readonly type: "text"; readonly delta: string }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly title: string;
      readonly details?: string;
      /**
       * The full, untruncated shell command (Bash tool only). `title`/`details`
       * are clipped for display, so anything matching on what actually ran - e.g.
       * spotting `gh pr review` at the end of a heredoc - must use this.
       */
      readonly command?: string;
      readonly status: "in_progress" | "complete" | "error";
    }
  /**
   * The run was killed before it finished (timeout, or a crash after it had
   * already produced text). Whatever was streamed is a fragment, not an answer -
   * a consumer that would otherwise present it as the result must say so.
   */
  | { readonly type: "aborted"; readonly reason: string };

/** Consumer of streaming events (e.g. the Slack streaming renderer). */
export type LlmStreamSink = (event: LlmStreamEvent) => void;

/**
 * A durable CLI session. The first turn creates it, later turns resume it, so
 * the model keeps its own context (and its files) between messages instead of
 * being replayed a transcript each time.
 */
export type LlmSession = {
  readonly id: string;
  /** false on the turn that creates the session, true for every one after. */
  readonly resume: boolean;
};

export type LlmCompleteParams = {
  readonly system: string;
  readonly messages: readonly PromptMessage[];
  /** Label for the bot's own turns in a rendered transcript. */
  readonly assistantName?: string;
  /** Per-call tool/sandbox policy (CLI adapter only); overrides adapter defaults. */
  readonly policy?: ToolPolicy;
  /**
   * Run this turn on someone else's Claude Code credential (CLI adapter only).
   * `CLAUDE_CODE_OAUTH_TOKEN` overrides whatever login the host is holding
   * (verified: a bogus value 401s even with a valid interactive session), so
   * this genuinely bills the person who asked, not the machine.
   */
  readonly oauthToken?: string;
  /**
   * Run on whatever interactive login the host holds, rather than on any setup
   * token (CLI adapter only).
   *
   * A `claude setup-token` credential carries NO claude.ai connector
   * authorisation - under one the CLI loads zero `mcp__` tools, verified - so a
   * task that genuinely needs a connector cannot run on one. Tickets need
   * Notion, and there is no Notion credential of our own to give them, so they
   * run on the host session instead. Everything else keeps the explicit token.
   */
  readonly useHostLogin?: boolean;
  /** Continue a durable session instead of a one-shot call (CLI adapter only). */
  readonly session?: LlmSession;
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
