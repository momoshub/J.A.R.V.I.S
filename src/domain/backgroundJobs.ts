/**
 * What a thread is told when background work its turn started died with the
 * run, and what the turn it is handed back is told.
 *
 * Pure text: `application/backgroundWatch.ts` decides when, this decides words.
 */

/** Hand-backs one thread gets per hour before it is only told, never handed a turn. */
export const MAX_HANDBACKS_PER_HOUR = 2;

const clip = (t: string): string => `\`${t.replace(/\s+/g, " ").slice(0, 80)}\``;

const names = (tasks: readonly string[]): string => tasks.map(clip).join(", ");

const what = (tasks: readonly string[]): string =>
  tasks.length === 1 ? "a background job was" : `${tasks.length} background jobs were`;

/**
 * The one short message posted in the thread the moment the work died: what
 * died, that it is not done, and what happens next.
 */
export const backgroundDiedNotice = (tasks: readonly string[], handedBack: boolean): string =>
  `_heads up: ${what(tasks)} cut off before finishing: ${names(tasks)}. Its work is not done. ${
    handedBack ? "I am picking it up in a new turn now." : "ask me to pick it up again."
  }_`;

/** The same, for work that died with the bot process itself (restart, crash). */
export const backgroundLostNotice = (tasks: readonly string[], handedBack: boolean, turnRunning = false): string =>
  `_heads up: I restarted while ${what(tasks)} still running, so ${tasks.length === 1 ? "it was" : "they were"} cut off: ${names(tasks)}. Its work is not done. ${
    handedBack
      ? "I am picking it up in a new turn now."
      : turnRunning
        ? "This thread already has a turn since the restart, so I did not start another."
        : "ask me to pick it up again."
  }_`;

/**
 * The turn the thread is handed back. It says the work is NOT done and why it
 * died, so it neither claims it nor starts a second copy of what is half-made,
 * and it must not repeat the mistake: an in-process background agent dies ten
 * minutes after the turn's answer.
 */
export const backgroundHandBack = (tasks: readonly string[], how: "cut" | "lost"): string =>
  [
    `[background work died] ${what(tasks)} killed before it reported: ${names(tasks)}.`,
    how === "lost"
      ? "The bot process restarted while it ran."
      : "The run that started it ended, and the CLI kills background agents ten minutes after a run's answer.",
    "It is NOT done, never assume anything it was working on finished. First look at what it left behind (files, branches, PRs, what the thread already shows), then finish the job yourself now - the person asked for it before, so this is finishing, not proposing.",
    "Do not start another in-process background agent for it: it would be cut the same way. Do it in this turn, or start an Orca worker and set `watch worker <dispatchId>`.",
    "Say in the thread, in a line, what is left and what you are doing.",
  ].join(" ");
