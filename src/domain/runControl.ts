/**
 * How a stopped or waiting turn is described out loud.
 *
 * Pure wording, kept out of the transport so the same sentences serve a button
 * click and a `stop` command - and so they can be asserted on
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
 * Whose turn may `by` stop? Your own, or anyone's when allowed to stop other
 * people's turns (`PERM.stopAny`: admin, owner). A turn is somebody's work and
 * often their money. The one rule behind the `stop` command and Slack's own stop
 * button, so the two cannot drift apart.
 */
export const mayStopRun = (run: { actor: string }, by: string, mayStopOthers: boolean): boolean =>
  mayStopOthers || run.actor === by;

/** What the `stop` command answers when the turn is someone else's and the caller may not stop it. */
export const stopRefusal = (run: { actor: string; startedAt: number }, now: number): string =>
  `That one is <@${run.actor}>'s, and it has been going ${forHowLong(now - run.startedAt)}. Only they or someone allowed to stop other people's turns can.`;

/** What the thread is told once a turn has been stopped. */
export const stoppedNotice = (
  run: { what: string; startedAt: number; actor: string },
  by: string,
  now: number,
): string => {
  const who = by === run.actor ? "" : ` by <@${by}>`;
  return `⏹ stopped *${run.what}*${who} after ${forHowLong(now - run.startedAt)}`;
};

/**
 * What a SECOND press is told, when the first one has not taken effect yet.
 *
 * It is deliberately not reassuring. Pressing stop four times on a wedged turn
 * produced four confident "stopped" lines while the process ran on, which is
 * worse than no button at all - the one thing someone needs to know here is
 * that the ask landed and the thing is refusing to die.
 */
export const stillStoppingNotice = (
  run: { what: string; stoppedAt?: number },
  now: number,
): string => {
  const waited = run.stoppedAt ? ` - ${forHowLong(now - run.stoppedAt)} ago now` : "";
  return `⏹ already stopping *${run.what}*${waited}. It has not let go yet; I am killing it harder.`;
};


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
