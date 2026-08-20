/**
 * Slack streaming renderer.
 *
 * Bridges E.V.'s `LlmStreamSink` onto Slack's native text-streaming API. Slack
 * owns the message: we `append` text deltas and `task_update` chunks (tool
 * cards) and `stop` at the end - no manual edits, so no edit rate limiting. The
 * stream is started lazily on the first event, so non-streaming replies (e.g.
 * `!commands`) never open one. Appends are serialised on a promise chain so they
 * never overlap; if any step fails the caller falls back to a plain post.
 *
 * For longer messages the caller can show a "thinking" step first
 * (`showThinking`), which auto-completes as soon as real content arrives.
 */
import type { TaskUpdateChunk } from "@slack/types";
import type { LlmStreamEvent, LlmStreamSink } from "../../application/ports.ts";

/** The slice of Slack's ChatStreamer we depend on (kept minimal for testing). */
export type Streamer = {
  append: (args: { markdown_text?: string; chunks?: TaskUpdateChunk[] }) => Promise<unknown>;
  stop: (args?: { markdown_text?: string }) => Promise<unknown>;
};

export type SlackStream = {
  sink: LlmStreamSink;
  /** Show a leading "thinking" task card (id is reserved, auto-completes). */
  showThinking: (title: string) => void;
  /** True once the underlying stream has been opened. */
  readonly started: boolean;
  /** Await pending appends and close the stream. False if it broke or showed no content. */
  finish: () => Promise<boolean>;
};

const THINKING_ID = "__thinking__";
const THINKING_DONE_TITLE = "🐦‍🔥";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const createSlackStream = (
  makeStreamer: () => Streamer,
  log: (msg: string) => void = () => {},
): SlackStream => {
  let streamer: Streamer | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let broke = false;
  let thinkingShown = false;
  let thinkingDone = false;
  let contentShown = false;

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
    task({ type: "task_update", id: THINKING_ID, title: THINKING_DONE_TITLE, status: "complete" });
  };

  const showThinking = (title: string) => {
    if (thinkingShown) return;
    thinkingShown = true;
    task({ type: "task_update", id: THINKING_ID, title, status: "in_progress" });
  };

  const sink: LlmStreamSink = (event: LlmStreamEvent) => {
    completeThinking(); // first real content ends the thinking step
    if (event.type === "text") {
      if (event.delta) {
        contentShown = true;
        const s = ensure();
        enqueue(() => s.append({ markdown_text: event.delta }));
      }
      return;
    }
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
    get started() {
      return streamer !== undefined;
    },
    finish: async () => {
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
