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
 *
 * A ```blockkit fence in the text is lifted out and sent as a `blocks` chunk in
 * its place (see `domain/blockKit.ts`), so tables, alerts and cards stream
 * inline with the prose around them.
 */
import type { AnyChunk, TaskUpdateChunk } from "@slack/types";
import { isHiddenAction } from "../../domain/toolVisibility.ts";
import { MAX_SILENCE_NOTE } from "../../domain/silence.ts";
import { createFenceNormalizer } from "./fences.ts";
import type { FinishedStep } from "../../domain/collapseSteps.ts";
import type { LlmUsage } from "../../application/ports.ts";
import { blocksToText, createBlockKitExtractor, type Block, type Segment } from "../../domain/blockKit.ts";
import type { LlmStreamEvent, LlmStreamSink } from "../../application/ports.ts";

/** The slice of Slack's ChatStreamer we depend on (kept minimal for testing). */
/** One message of a streamed reply and what it showed. */
export type StreamPart = { readonly ts: string; readonly text: string };

export type Streamer = {
  append: (args: { markdown_text?: string; chunks?: AnyChunk[] }) => Promise<unknown>;
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

/**
 * Where to cut `text` so the piece fits in `room`: all of it when it fits,
 * else just after the last line break, else after the last space. A cut in
 * the middle of a word showed up as "I restart o" / "nce idle" across two
 * messages - and since task cards eat the same allowance, a short reply in a
 * tool-heavy turn is exactly where it happens. With no break in reach it
 * answers 0 (roll over first, the whole room is then free), unless the
 * message is already fresh, where only a hard cut can make progress.
 */
export const rolloverCut = (text: string, room: number, fresh: boolean): number => {
  if (text.length <= room) return text.length;
  const head = text.slice(0, room);
  const line = head.lastIndexOf("\n");
  if (line > 0) return line + 1;
  const space = head.lastIndexOf(" ");
  if (space > 0) return space + 1;
  return fresh ? room : 0;
};

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
  /**
   * The tool steps this message showed, with how each ended. Read after
   * `finish` to collapse the column of cards into one line.
   */
  readonly steps: readonly FinishedStep[];
  /** What the run cost, once the CLI has reported it. Undefined until then. */
  readonly usage: LlmUsage | undefined;
  /**
   * Every message the reply was spread across, oldest first, with the text
   * each one actually carried (a Block Kit chunk as its ```blockkit fence).
   * More than one means it rolled over, and `ts` is only the LAST of them - so
   * rewriting that one with the whole answer posts it twice. Each message is
   * tidied with its own part instead. Only messages Slack actually took an
   * append for are listed: one whose first append failed never existed.
   */
  readonly parts: readonly StreamPart[];
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

/**
 * Step cards one streamed message holds while it runs. Slack has no way to
 * take a card away (`task_update` has only pending / in_progress / complete /
 * error), so the message gets a fixed set of this many slots, reused by the
 * newest steps; see `slots` in `createSlackStream`. It only holds more when
 * more steps than this are running at once - every step in progress is shown.
 */
export const VISIBLE_STEP_SLOTS = 5;

/**
 * The log pointer a tool event carries in `details`: `log at: <file> - line <n>`.
 * Slack APPENDS a card's `details` on every update instead of replacing them
 * (measured: `XX` then `YY` shows `XXYY`, and the same text twice shows it
 * twice), so a card taken over by another step cannot be given that step's
 * pointer. The file is the same for the whole thread, so it is sent once per
 * card, where it stays true for whichever step holds it, and the line number -
 * the part that differs - goes in the title, which an update does replace.
 */
const LOG_POINTER = /^(log at: .+?) - line (\d+)$/;

/** A card title with the step's log line on the end, clipped like `runsLabel`. */
const withLogLine = (title: string, line: string): string => {
  const suffix = ` · log line ${line}`;
  return title.length + suffix.length > 200 ? `${title.slice(0, 197 - suffix.length)}...${suffix}` : title + suffix;
};

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type SlackStreamOptions = {
  /**
   * Open nothing until the turn is plainly doing something: a visible tool
   * call, or more text than a silence note could be. Text before that is held
   * and sent when the stream opens.
   *
   * For a followed thread. Most of those turns say nothing, and a stream opened
   * at the start leaves a message behind for each of them - or shows "nothing
   * to add" to the channel before the boundary can drop it. Not streaming at
   * all was the other failure: a turn asked to fix something worked for
   * minutes with no sign it had heard. A turn that never opens is posted
   * plainly by the caller, which is where the silence check runs.
   */
  holdUntilWorking?: boolean;
  /**
   * Called once per message the reply opens, with its ts. Lets the caller
   * remember where a half-written reply is, so it can be tidied up if the
   * process dies before the stream is closed.
   */
  onOpen?: (ts: string) => void;
};

export const createSlackStream = (
  makeStreamer: () => Streamer,
  log: (msg: string) => void = () => {},
  /** Title the thinking card flips to once real content arrives. */
  thinkingDoneLabel = "✅",
  options: SlackStreamOptions = {},
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
  const kit = createBlockKitExtractor();

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

  /** Per opened message: the streamer, and the text it was sent. */
  const opened: { streamer: Streamer; text: string; live: boolean }[] = [];
  /** Message ts already reported through `onOpen`. */
  const announced = new Set<string>();
  const ensure = (): Streamer => {
    if (!streamer) {
      streamer = makeStreamer();
      opened.push({ streamer, text: "", live: false });
    }
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
    record(args);
    const ts = streamer?.ts;
    if (ts && !announced.has(ts)) {
      announced.add(ts);
      try {
        options.onOpen?.(ts);
      } catch (e) {
        log(`onOpen failed: ${errMsg(e)}`);
      }
    }
  };

  /** Note what the current message now shows, so it can be rebuilt without its cards. */
  const record = (args: Parameters<Streamer["append"]>[0]): void => {
    const current = opened[opened.length - 1];
    if (!current) return;
    current.live = true;
    if (args.markdown_text) current.text += args.markdown_text;
    for (const c of args.chunks ?? []) {
      const blocks = (c as { type?: string; blocks?: unknown }).type === "blocks" ? (c as { blocks: unknown }).blocks : undefined;
      if (blocks) current.text += `\n\`\`\`blockkit\n${JSON.stringify(blocks)}\n\`\`\`\n`;
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
        const cut = rolloverCut(rest, STREAM_CHAR_BUDGET - used, used === 0);
        if (cut === 0) {
          await rollover();
          continue;
        }
        const piece = rest.slice(0, cut);
        rest = rest.slice(cut);
        await send({ markdown_text: piece }, piece.length);
      }
    });
  };

  /**
   * Send a run of blocks as one chunk, in order with the text around it.
   *
   * Slack refuses a block it does not support in a message (`alert` is
   * rejected with `invalid_blocks` even though the SDK types it) or one that
   * breaks its schema (an empty table cell came back `invalid_arguments`), and a
   * refusal would otherwise break the stream for the whole turn: the reply
   * split in two and the table vanished. So a refused chunk is shown as the
   * words it holds instead (its JSON in a code block when it holds none): the
   * content survives, and the rest of the reply keeps streaming.
   */
  const appendBlocks = (blocks: Block[]) => {
    ensure();
    const chunk = { type: "blocks", blocks } as AnyChunk;
    enqueue(async () => {
      try {
        await send({ chunks: [chunk] }, JSON.stringify(chunk).length);
      } catch (e) {
        if (!/invalid_blocks|invalid_arguments/.test(errMsg(e))) throw e;
        // A refused chunk was never shown, so it is not part of the allowance.
        used = Math.max(0, used - JSON.stringify(chunk).length);
        log(`blocks refused, shown as text: ${errMsg(e)}`);
        const words = blocksToText(blocks);
        const shown = words ? `\n${words}\n\n` : `\n\`\`\`\n${JSON.stringify(blocks, null, 2)}\n\`\`\`\n`;
        await send({ markdown_text: shown }, shown.length);
      }
    });
  };

  /**
   * Route extracted segments: prose through the fence normaliser, blocks as a
   * chunk. Whatever the normaliser held back goes out first, or a block would
   * overtake the end of the sentence that introduced it.
   */
  const emitSegments = (segs: Segment[]) => {
    for (const seg of segs) {
      if (seg.kind === "text") {
        const text = fences.push(seg.text);
        if (text) appendText(text);
        continue;
      }
      const held = fences.flush();
      if (held) appendText(held);
      appendBlocks(seg.blocks);
    }
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

  /**
   * The cards on screen, as reusable slots. Slack cannot remove a card, but a
   * `task_update` with an id it already has rewrites that card in place (title,
   * status, details; measured: it keeps its position). So the message holds
   * `VISIBLE_STEP_SLOTS` cards, and once they all exist a step that starts
   * takes over the slot of the oldest FINISHED one, under that slot's id: the
   * older step is gone from the message, the newest five stay. A step in
   * progress is never taken over, so every running step stays visible, and
   * the slots grow past the limit only when more are running than there are
   * slots. A slot keeps the id of the card that first opened it, so a turn
   * with five steps or fewer is sent exactly as it was.
   *
   * It cannot also hold five FINISHED steps next to a running one: that is six
   * cards, and with no way to remove the sixth the message would keep six once
   * the step ends.
   */
  type Slot = { id: string; card: string; hasDetails: boolean; line: string | undefined; doneAt: number | undefined };
  const slots: Slot[] = [];
  const slotOf = new Map<string, Slot>();
  let finishedCount = 0;

  /** Where a tool card goes in the message: its slot, taking one over when all the slots are in use. */
  const placeCard = (event: Extract<LlmStreamEvent, { type: "tool" }>): Slot => {
    let slot = slotOf.get(event.id);
    if (!slot) {
      const finished = slots.filter((x) => x.doneAt !== undefined);
      if (slots.length >= VISIBLE_STEP_SLOTS && finished.length > 0) {
        const oldest = finished.reduce((a, b) => ((a.doneAt as number) <= (b.doneAt as number) ? a : b));
        slotOf.delete(oldest.card);
        oldest.card = event.id;
        oldest.line = undefined;
        oldest.doneAt = undefined;
        slot = oldest;
      } else {
        slot = { id: event.id, card: event.id, hasDetails: false, line: undefined, doneAt: undefined };
        slots.push(slot);
      }
      slotOf.set(event.id, slot);
    }
    const done = event.status === "complete" || event.status === "error";
    slot.doneAt = done ? (slot.doneAt ?? ++finishedCount) : undefined;
    return slot;
  };

  const forward = (event: LlmStreamEvent): void => {
    cancelPending(); // something arrived, so no placeholder is needed
    completeThinking(); // first real content ends the thinking step
    if (event.type === "text") {
      if (event.delta) {
        contentShown = true;
        emitSegments(kit.push(event.delta));
      }
      return;
    }
    // An aborted run is the caller's to narrate (it knows what was at stake);
    // there is no card to draw for it.
    if (event.type === "aborted") return;
    if (event.type === "usage") return;
    contentShown = true;
    // What the column showed, so it can be collapsed once the turn is done.
    // The thinking card is the bot's own placeholder, not a step anyone did.
    if (event.id !== THINKING_ID) {
      shown.set(event.id, { title: event.title, failed: event.status === "error" });
    }
    if (event.id === THINKING_ID) {
      task({ type: "task_update", id: event.id, title: event.title, status: event.status });
      return;
    }
    const slot = placeCard(event);
    const pointer = event.details ? LOG_POINTER.exec(event.details) : null;
    const details = pointer && !slot.hasDetails ? pointer[1] : undefined;
    if (details) slot.hasDetails = true;
    // The finishing update has no pointer, and a title update replaces the old one.
    if (pointer?.[2]) slot.line = pointer[2];
    task({
      type: "task_update",
      id: slot.id,
      title: slot.line ? withLogLine(event.title, slot.line) : event.title,
      status: event.status,
      ...(details ? { details } : {}),
    });
  };

  /**
   * Repeats of the same step share one card. A turn that runs the same query
   * five times showed five identical cards; now it shows one, titled
   * "... (5 runs)", that completes when the last of them does.
   *
   * "The same" means the whole input, not the card title: titles are clipped,
   * and an MCP call's title is only the tool name, so grouping on it merged
   * five different SQL queries into one card that showed just the first.
   */
  type Group = { id: string; title: string; details?: string; count: number; open: number; failed: boolean };
  const groups = new Map<string, Group>();
  const groupOf = new Map<string, Group>();
  /**
   * Every step that got a card, by card id, with how it ended. Keyed so a
   * step that is drawn in progress and then completed counts once - the
   * column has one card for it, so the summary must count one.
   */
  const shown = new Map<string, FinishedStep>();
  /**
   * What the run cost. It arrives once, at the very end, and is NOT content:
   * it must never open a stream, end the thinking step, or count as something
   * to show - it is written into the footer after the turn is over.
   */
  let usage: LlmUsage | undefined;
  const runsLabel = (title: string, count: number): string => {
    const suffix = ` (${count} runs)`;
    return title.length + suffix.length > 200 ? `${title.slice(0, 197 - suffix.length)}...${suffix}` : title + suffix;
  };
  const groupCard = (g: Group, status: "in_progress" | "complete" | "error"): LlmStreamEvent => ({
    type: "tool",
    id: g.id,
    title: runsLabel(g.title, g.count),
    status,
    ...(g.details ? { details: g.details } : {}),
  });

  /** The event to show for a tool step, or undefined when its group's card already covers it. */
  const grouped = (event: Extract<LlmStreamEvent, { type: "tool" }>): LlmStreamEvent | undefined => {
    if (event.status === "in_progress") {
      if (groupOf.has(event.id)) return event;
      // details is a log pointer that differs per call, so it is no part of the key
      const key = event.command ?? event.title;
      const g = groups.get(key);
      if (!g) {
        const fresh = { id: event.id, title: event.title, details: event.details, count: 1, open: 1, failed: false };
        groups.set(key, fresh);
        groupOf.set(event.id, fresh);
        return event;
      }
      groupOf.set(event.id, g);
      g.count += 1;
      g.open += 1;
      return groupCard(g, "in_progress");
    }
    const g = groupOf.get(event.id);
    if (!g) return event;
    g.open = Math.max(0, g.open - 1);
    g.failed ||= event.status === "error";
    if (g.count === 1) return event;
    if (g.open > 0) return undefined;
    return groupCard(g, g.failed ? "error" : "complete");
  };

  let holding = options.holdUntilWorking === true;
  let held = "";

  const sink: LlmStreamSink = (event: LlmStreamEvent) => {
    // Kept for the footer and nothing else: it must not open a stream, end the
    // thinking step, or count as content, all of which `forward` would do.
    if (event.type === "usage") {
      usage = event.usage;
      return;
    }
    // Hidden actions (reacting, remembering, anything on the local host) leave no
    // trace here: no card, and they do not count as content or end the thinking step.
    if (event.type === "tool" && isHiddenAction(event.command)) return;
    if (event.type === "tool") {
      const shown = grouped(event);
      if (!shown) return;
      event = shown;
    }
    if (holding) {
      if (event.type === "aborted") return;
      if (event.type === "text") {
        held += event.delta;
        if (held.trim().length <= MAX_SILENCE_NOTE) return;
      }
      holding = false;
      const text = held;
      held = "";
      if (event.type === "text") {
        forward({ type: "text", delta: text });
        return;
      }
      if (text) forward({ type: "text", delta: text });
    }
    forward(event);
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
    get steps() {
      return [...shown.values()];
    },
    get usage() {
      return usage;
    },
    get parts() {
      return opened.flatMap((o) => (o.live && o.streamer.ts ? [{ ts: o.streamer.ts, text: o.text }] : []));
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
      emitSegments(kit.flush());
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
