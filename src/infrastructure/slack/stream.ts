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
import { createFenceNormalizer } from "./fences.ts";
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

/**
 * Characters of text one streamed message may carry before it is rolled over
 * into a continuation.
 *
 * Slack caps a streamed message at 12,000 characters - measured, not guessed:
 * appending 2,000 at a time succeeded through 10,005 and the next chunk failed
 * with `msg_too_long`, and so did `stop`. That failure is not a truncation, it
 * is a LOSS: the append throws, the stream breaks, and a long answer that took
 * minutes to produce never arrives at all. `msg_too_long` appears dozens of
 * times in this instance's log.
 *
 * So a long reply continues in a second message instead. Task cards share the
 * same allowance, so they are counted too: a tool-heavy turn with a one-line
 * status hit the wall on cards alone, froze the status line, and the answer
 * never came.
 */
export const STREAM_CHAR_BUDGET = 11_000;

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
  /**
   * Give up on this turn: cancel an armed placeholder and close anything that
   * was already opened. Returns the ts of a message left behind that holds no
   * real content, so the caller can take it away again.
   *
   * A turn that is queued or dropped used to return without touching the
   * stream at all, leaving the armed timer to fire a few seconds later into a
   * turn that no longer existed - which is where the stray "thinking" cards in
   * a busy thread came from.
   */
  abandon: () => Promise<{ emptyTs?: string }>;
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
  /** Characters appended to the CURRENT message, for the rollover. */
  let used = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const fences = createFenceNormalizer();

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

  /** Close the current message so the next append opens a fresh one. */
  const rollover = async (): Promise<void> => {
    if (!streamer) return;
    try {
      await streamer.stop();
    } catch {
      // nothing more to do about it; the continuation still goes out
    }
    streamer = undefined;
    used = 0;
  };

  /**
   * Append to the current message, rolling over first when `cost` would not
   * fit. If Slack still says `msg_too_long` - its accounting is not ours - roll
   * over and try once more rather than breaking the stream for the whole turn.
   */
  const send = async (args: Parameters<Streamer["append"]>[0], cost: number): Promise<void> => {
    if (used > 0 && used + cost > STREAM_CHAR_BUDGET) await rollover();
    used += cost;
    try {
      await ensure().append(args);
    } catch (e) {
      if (!errMsg(e).includes("msg_too_long") || used === cost) throw e;
      await rollover();
      used = cost;
      await ensure().append(args);
    }
  };

  /** What a card costs against the allowance: its serialised size, a safe overestimate. */
  const cardCost = (chunk: TaskUpdateChunk): number => JSON.stringify(chunk).length;

  const task = (chunk: TaskUpdateChunk) => {
    ensure();
    enqueue(() => send({ chunks: [chunk] }, cardCost(chunk)));
  };

  /**
   * Append text, rolling over to a fresh message before Slack would refuse it.
   *
   * The length check happens INSIDE the chain so it sees the real running
   * total: appends are serialised, and deciding outside would race with
   * whatever is still in flight.
   */
  const appendText = (text: string) => {
    ensure();
    enqueue(async () => {
      let rest = text;
      while (rest) {
        if (used >= STREAM_CHAR_BUDGET) await rollover();
        const room = STREAM_CHAR_BUDGET - used;
        const piece = rest.length <= room ? rest : rest.slice(0, room);
        rest = rest.slice(piece.length);
        await send({ markdown_text: piece }, piece.length);
      }
    });
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
        const text = fences.push(event.delta);
        if (text) appendText(text);
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
    abandon: async () => {
      cancelPending();
      if (!streamer) return {};
      completeThinking();
      try {
        await chain;
      } catch {
        // already swallowed into `broke`
      }
      const ts = streamer.ts;
      try {
        await streamer.stop();
      } catch {
        // closing a stream nobody will read is not worth reporting
      }
      return contentShown ? {} : { emptyTs: ts };
    },
    finish: async () => {
      cancelPending();
      completeThinking();
      const tail = fences.flush();
      if (tail) appendText(tail);
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
