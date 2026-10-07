/**
 * How a stopped or waiting turn is described out loud.
 *
 * Pure wording, kept out of the transport so the same sentences serve a button
 * click, a `stop` command and the queue notice - and so they can be asserted on
 * without a Slack in the way.
 */

/** A duration someone reads at a glance, not a timestamp they decode. */
export const forHowLong = (ms: number): string => {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  return mins < 60 ? `${mins}m` : `${Math.round((mins / 60) * 10) / 10}h`;
};

/**
 * What the thread is told when a new message lands on a busy turn.
 *
 * It names what is already running, because "still on the one before this" does
 * not say which one, and in a thread with several asks in flight that is the
 * only thing the reader actually needs.
 */
export const busyNotice = (running: { what: string; startedAt: number }, now: number): string =>
  `⏳ still working on *${running.what}* (${forHowLong(now - running.startedAt)} so far) - yours is next`;

/** What the thread is told once a turn has been stopped. */
export const stoppedNotice = (
  run: { what: string; startedAt: number; actor: string },
  by: string,
  now: number,
): string => {
  const who = by === run.actor ? "" : ` by <@${by}>`;
  return `⏹ stopped *${run.what}*${who} after ${forHowLong(now - run.startedAt)}`;
};

/** What a dropped-before-it-ran message is told. */
export const droppedNotice = (what: string, by: string): string =>
  `✖ dropped *${what}* - <@${by}> called it off before I got to it`;

/**
 * A request shortened to something that fits on a button's worth of context.
 * Newlines and mention tags are stripped: this is a label, not a quote.
 */
export const nameOfRequest = (text: string, max = 48): string => {
  const flat = text
    .replace(/<@[A-Z0-9]+(?:[|:][^>]*)?>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "that one";
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
