/**
 * Slack streaming renderer.
 *
 * Bridges the bot's `LlmStreamSink` onto Slack's native text-streaming API. Slack
 * owns the message: we `append` text deltas and `task_update` chunks (tool
 * cards) and `stop` at the end - no manual edits, so no edit rate limiting. The
 * stream is started lazily on the first event, so non-streaming replies (e.g.
 * `!commands`) never open one. Appends are serialised on a promise chain so they
 * never overlap; if any step fails the caller falls back to a plain post.
 *
 * The caller can arm a "thinking" step (`showThinkingAfter`), which appears only
 * if the turn is still silent when the delay is up and auto-completes as soon as
 * real content arrives - so a quick answer never flashes a placeholder.
 */
import type { TaskUpdateChunk } from "@slack/types";
import { isHiddenAction } from "../../domain/toolVisibility.ts";
import type { LlmStreamEvent, LlmStreamSink } from "../../application/ports.ts";

/** The slice of Slack's ChatStreamer we depend on (kept minimal for testing). */
export type Streamer = {
  append: (args: { markdown_text?: string; chunks?: TaskUpdateChunk[] }) => Promise<unknown>;
  stop: (args?: { markdown_text?: string }) => Promise<unknown>;
  /** ts of the streamed message; undefined until the first flush opens it. */
  readonly ts?: string;
};

/** How long a turn may stay silent before a "thinking" card is worth showing. */
export const THINKING_AFTER_MS = 5_000;

export type SlackStream = {
  sink: LlmStreamSink;
  /** Show a leading "thinking" task card now (id is reserved, auto-completes). */
  showThinking: (title: string) => void;
  /**
   * Show that card only if nothing has arrived yet after `delayMs`. A turn that
   * answers quickly never shows one at all.
   */
  showThinkingAfter: (title: string, delayMs?: number) => void;
  /** True once the underlying stream has been opened. */
  readonly started: boolean;
  /** ts of the streamed message, once Slack has assigned one. */
  readonly ts: string | undefined;
  /** Await pending appends and close the stream. False if it broke or showed no content. */
  finish: () => Promise<boolean>;
};

const THINKING_ID = "__thinking__";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const createSlackStream = (
  makeStreamer: () => Streamer,
  log: (msg: string) => void = () => {},
  /** Title the thinking card flips to once real content arrives. */
  thinkingDoneLabel = "✅",
): SlackStream => {
  let streamer: Streamer | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let broke = false;
  let thinkingShown = false;
  let thinkingDone = false;
  let contentShown = false;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const cancelPending = (): void => {
    if (pending === undefined) return;
    clearTimeout(pending);
    pending = undefined;
  };

  const enqueue = (fn: () => Promise<unknown>): void => {
    chain = chain.then(fn).catch((e) => {
      if (!broke) log(`stream step failed: ${errMsg(e)}`);
      broke = true;
    });
  };

  const ensure = (): Streamer => {
    if (!streamer) streamer = makeStreamer();
    return streamer;
  };

  const task = (chunk: TaskUpdateChunk) => {
    const s = ensure();
    enqueue(() => s.append({ chunks: [chunk] }));
  };

  const completeThinking = () => {
    if (!thinkingShown || thinkingDone) return;
    thinkingDone = true;
    task({ type: "task_update", id: THINKING_ID, title: thinkingDoneLabel, status: "complete" });
  };

  const showThinking = (title: string) => {
    if (thinkingShown) return;
    thinkingShown = true;
    task({ type: "task_update", id: THINKING_ID, title, status: "in_progress" });
  };

  const showThinkingAfter = (title: string, delayMs = THINKING_AFTER_MS) => {
    cancelPending();
    pending = setTimeout(() => {
      pending = undefined;
      // Content beat the timer, so there is nothing to reassure anyone about.
      if (!contentShown) showThinking(title);
    }, delayMs);
    // Never hold the process open for a placeholder.
    (pending as { unref?: () => void }).unref?.();
  };

  const sink: LlmStreamSink = (event: LlmStreamEvent) => {
    // Hidden actions (reacting, remembering, anything on the local host) leave no
    // trace here: no card, and they do not count as content or end the thinking step.
    if (event.type === "tool" && isHiddenAction(event.command)) return;
    cancelPending(); // something arrived, so no placeholder is needed
    completeThinking(); // first real content ends the thinking step
    if (event.type === "text") {
      if (event.delta) {
        contentShown = true;
        const s = ensure();
        enqueue(() => s.append({ markdown_text: event.delta }));
      }
      return;
    }
    // An aborted run is the caller's to narrate (it knows what was at stake);
    // there is no card to draw for it.
    if (event.type === "aborted") return;
    contentShown = true;
    task({
      type: "task_update",
      id: event.id,
      title: event.title,
      status: event.status,
      ...(event.details ? { details: event.details } : {}),
    });
  };

  return {
    sink,
    showThinking,
    showThinkingAfter,
    get started() {
      return streamer !== undefined;
    },
    get ts() {
      return streamer?.ts;
    },
    finish: async () => {
      cancelPending();
      completeThinking();
      try {
        await chain;
      } catch {
        // chain already swallows errors into `broke`
      }
      if (!streamer) return false;
      try {
        await streamer.stop();
      } catch (e) {
        log(`stream stop failed: ${errMsg(e)}`);
        return false;
      }
      return contentShown && !broke;
    },
  };
};
