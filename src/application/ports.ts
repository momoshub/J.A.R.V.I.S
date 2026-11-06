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
  | { readonly type: "aborted"; readonly reason: string }
  /**
   * What the run cost, from the CLI's final `result` line. Arrives once, at
   * the end, so a renderer can put it under the reply.
   */
  | { readonly type: "usage"; readonly usage: LlmUsage };

/** Consumer of streaming events (e.g. the Slack streaming renderer). */
export type LlmStreamSink = (event: LlmStreamEvent) => void;

/**
 * What one run of the model actually cost.
 *
 * Every turn spawns a CLI process and some of them run for ten minutes, and
 * until now nothing anywhere recorded what that came to - not per person, not
 * per command, not in total. "We have no idea what this costs" is a bad answer
 * to the only question a finance team ever asks about an AI tool.
 *
 * `costUsd` is the CLI's own figure at LIST price (its `total_cost_usd`). On a
 * subscription credential nobody is literally invoiced that, so it is an
 * estimate of consumption rather than a bill, and it is labelled that way
 * wherever it is shown.
 */
export type LlmUsage = {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
};

/** Who a run is charged to, and what it was for. */
export type BillingContext = {
  /** Slack id of the person whose request this is. */
  readonly actor: string;
  /** `chat`, `workflow`, or the command's name. */
  readonly kind: string;
  readonly channel?: string;
  /** Thread the run belongs to, so its tool calls land in that thread's log. */
  readonly threadTs?: string;
};

/**
 * One tool call or its result, in full - the cards in Slack are clipped to a
 * line, so this is the record to read when a turn has to be debugged later.
 * `parent` is set for a subagent's own steps: the Task call that spawned it.
 */
export type ToolTrace =
  | { readonly kind: "call"; readonly id: string; readonly name: string; readonly input: string; readonly parent?: string }
  | { readonly kind: "result"; readonly id: string; readonly isError: boolean; readonly output: string; readonly parent?: string };

/** Told about every tool call and result; wired at the composition root. */
export type ToolTraceSink = (trace: ToolTrace, bill: BillingContext | undefined) => void;

/** Whose credential paid: the bot's own, the caller's token, or the host login. */
export type UsagePayer = "bot" | "caller" | "host";

/** Told about every finished run; wired at the composition root. */
export type UsageSink = (
  usage: LlmUsage,
  payer: UsagePayer,
  bill: BillingContext | undefined,
) => void;

/**
 * A durable CLI session. The first turn creates it, later turns resume it, so
 * the model keeps its own context (and its files) between messages instead of
 * being replayed a transcript each time.
 */
export type LlmSession = {
  readonly id: string;
  /** false on the turn that creates the session, true for every one after. */
  readonly resume: boolean;
  /**
   * The display name other sessions see it under. A thread's session is named
   * after the thread, so one thread can find and message another's.
   */
  readonly name?: string;
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
  /**
   * Ends the run when aborted (CLI adapter only): the child process is killed,
   * exactly as the timeout does. A turn can last the better part of an hour, so
   * there has to be a way to stop one that is going the wrong way.
   */
  readonly signal?: AbortSignal;
  /**
   * This turn's command ticket, placed in the spawned CLI's environment rather
   * than written into its prompt (CLI adapter only).
   *
   * A thread holds one long-lived session, so the model's context accumulates
   * every prompt it has been handed. A ticket printed there is one the model
   * will eventually retype from memory - dead by then, and belonging to
   * whoever was speaking at the time. A process environment cannot be stale.
   */
  readonly runTicket?: string;
  /** Continue a durable session instead of a one-shot call (CLI adapter only). */
  readonly session?: LlmSession;
  /**
   * Who this run is for, so what it cost can be attributed. Optional because a
   * run that cannot say whose it is should still happen - it is recorded
   * without an owner rather than not recorded at all.
   */
  readonly bill?: BillingContext;
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
