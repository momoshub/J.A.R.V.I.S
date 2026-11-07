/**
 * Workflow auto-continue - the rules, no I/O.
 *
 * A workflow used to advance only when a human spoke: the model ended a turn
 * with "in progress, next is X", the turn was over, and nothing ran until
 * somebody asked "is it dead?" hours later. Now a turn that has more to do and
 * is not waiting on anyone ends with a `[continue]` line; the bot strips it
 * from what is posted and queues the next step itself.
 */

/** What the model puts on a line of its own to ask for the next step. */
export const CONTINUE_MARKER = "[continue]";

/** Consecutive steps a workflow may take on its own before it pauses for a human. */
export const AUTO_CONTINUE_CAP = 30;

/**
 * Wait before the next step is queued. Long enough that a message somebody
 * typed while the last step was finishing gets into the thread queue first.
 */
export const CONTINUE_DELAY_MS = 5_000;

/** What the session is told when it carries on by itself. */
export const CONTINUE_MESSAGE = "carry on with the next step of the task";

export type ParsedTurn = {
  /** The reply with the marker taken out - what the thread should see. */
  readonly text: string;
  /** The model asked to carry on without waiting for a human. */
  readonly wantsContinue: boolean;
};

/** A marker line, allowing for the model wrapping it in code or emphasis. */
const isMarkerLine = (line: string): boolean =>
  line.trim().replace(/^[`*_]+|[`*_]+$/g, "").trim().toLowerCase() === CONTINUE_MARKER;

const MARKER_ANYWHERE = /`?\[continue\]`?/gi;

/**
 * Read a turn's reply: did it ask to continue, and what is left to post.
 * Only a line holding the marker alone counts as the request; any stray copy
 * of it is still removed, since it means nothing to the person reading.
 */
export const parseContinue = (raw: string): ParsedTurn => {
  const lines = raw.split("\n");
  const wantsContinue = lines.some(isMarkerLine);
  const text = lines
    .filter((l) => !isMarkerLine(l))
    .join("\n")
    .replace(MARKER_ANYWHERE, "")
    .trim();
  return { text, wantsContinue };
};

/**
 * Strip the marker out of a live stream. A delta can end part way through it
 * (`... next: [cont`), so a tail that could still become the marker is held
 * back until the next delta settles it. `flush` releases whatever is held.
 */
export const createMarkerFilter = (): { push: (delta: string) => string; flush: () => string } => {
  let held = "";
  const push = (delta: string): string => {
    const text = (held + delta).replace(/\[continue\]/gi, "");
    held = "";
    // Hold back the longest tail that is a prefix of the marker.
    for (let n = Math.min(CONTINUE_MARKER.length - 1, text.length); n > 0; n--) {
      const tail = text.slice(-n);
      if (CONTINUE_MARKER.startsWith(tail.toLowerCase())) {
        held = tail;
        return text.slice(0, -n);
      }
    }
    return text;
  };
  const flush = (): string => {
    const out = held;
    held = "";
    return out;
  };
  return { push, flush };
};

/** Posted once when a workflow has carried on by itself as far as it may. */
export const pausedNotice = (cap: number, prefix = "//bot"): string =>
  `⏸️ paused after ${cap} steps in a row on my own. Say anything here (\`carry on\` will do) to resume, or \`${prefix} workflow stop\` to end it.`;
