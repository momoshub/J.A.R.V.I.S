/**
 * Slack streaming renderer.
 *
 * Bridges E.V.'s `LlmStreamSink` onto Slack's native text-streaming API. Slack
 * owns the message: we `append` text deltas and `task_update` chunks (tool
 * cards) and `stop` at the end - no manual edits, so no edit rate limiting. The
 * stream is started lazily on the first event, so non-streaming replies (e.g.
 * `!commands`) never open one. Appends are serialised on a promise chain so they
 * never overlap; if any step fails the caller falls back to a plain post.
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
  /** True once the underlying stream has been opened. */
  readonly started: boolean;
  /** Await pending appends and close the stream. Returns false if it broke. */
  finish: () => Promise<boolean>;
};

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const createSlackStream = (
  makeStreamer: () => Streamer,
  log: (msg: string) => void = () => {},
): SlackStream => {
  let streamer: Streamer | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let broke = false;

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

  const sink: LlmStreamSink = (event: LlmStreamEvent) => {
    const s = ensure();
    if (event.type === "text") {
      if (event.delta) enqueue(() => s.append({ markdown_text: event.delta }));
      return;
    }
    const chunk: TaskUpdateChunk = {
      type: "task_update",
      id: event.id,
      title: event.title,
      status: event.status,
      ...(event.details ? { details: event.details } : {}),
    };
    enqueue(() => s.append({ chunks: [chunk] }));
  };

  return {
    sink,
    get started() {
      return streamer !== undefined;
    },
    finish: async () => {
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
      return !broke;
    },
  };
};
