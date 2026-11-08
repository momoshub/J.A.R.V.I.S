/**
 * Tidying a finished turn's message.
 *
 * A long turn leaves a column of tool cards above its answer - "run: cd ...",
 * "run: sqlite3 ...", twenty of them - and once the work is done none of it is
 * worth the room. Reading the thread back a day later, the cards are what you
 * have to scroll past to find the sentence that mattered.
 *
 * So when the turn ends the message is rewritten: the answer, then one line
 * saying how much work went into it, and the steps that FAILED kept in full.
 * Failures stay because they are the part somebody may need to act on - a
 * refused permission, a command that did not exist - and summarising those
 * away would hide the one thing worth seeing.
 *
 * Nothing is collapsed while the turn is still running: watching the steps
 * arrive is how anyone knows it is alive. This is strictly an after.
 */
import type { Block } from "./blockKit.ts";
import { FOOTER_BLOCK_ID } from "./messageFooter.ts";

export type FinishedStep = {
  readonly title: string;
  readonly failed: boolean;
};

/** Longest a kept failure line may be before it is clipped. */
const FAILURE_CHARS = 160;

const clip = (text: string, max = FAILURE_CHARS): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
};

export type Collapsed = {
  /** "🔧 14 steps, 2 failed" - the one line that replaces the column. */
  readonly summary: string;
  /** Failures, kept in full because they are the actionable part. */
  readonly failures: readonly string[];
};

/**
 * What a finished turn's steps should collapse to, or undefined when there is
 * nothing worth collapsing.
 *
 * One step is left alone: replacing a single card with a line that says
 * "1 step" is not a tidy-up, it is a swap.
 */
export const collapseSteps = (steps: readonly FinishedStep[]): Collapsed | undefined => {
  const real = steps.filter((s) => s.title.trim());
  if (real.length < 2) return undefined;
  const failures = real.filter((s) => s.failed).map((s) => clip(s.title));
  const summary =
    failures.length > 0
      ? `🔧 ${real.length} steps, ${failures.length} failed`
      : `🔧 ${real.length} steps`;
  return { summary, failures };
};

/**
 * The rewritten message: the answer first, then what it took.
 *
 * ONE grey line, not two. The step summary and the usage footer were built
 * separately and collided in the same place, which is the honest reason they
 * are merged here rather than stacked: two context blocks under one answer is
 * exactly the clutter this is meant to remove.
 *
 * The body goes in a `markdown` block, which Slack renders the same way the
 * streamed text was rendered, so collapsing does not change how the answer
 * looks - only what sits under it.
 */
export const collapsedBlocks = (
  body: string,
  collapsed?: Collapsed,
  /**
   * The signed footer line (`Jarvis · model · in 95.9k · ... · 3m 16s · updated
   * <time>`, see messageFooter.ts). When given, the grey block carries the
   * footer's block_id so a later edit can restamp it.
   */
  footer?: string,
): Block[] => {
  const blocks: Block[] = [];
  if (body.trim()) blocks.push({ type: "markdown", text: body });
  const lines = [
    ...(collapsed ? [collapsed.summary, ...collapsed.failures.map((f) => `• ${f}`)] : []),
    ...(footer?.trim() ? [footer.trim()] : []),
  ];
  if (lines.length > 0) {
    blocks.push({
      type: "context",
      ...(footer?.trim() ? { block_id: FOOTER_BLOCK_ID } : {}),
      elements: [{ type: "mrkdwn", text: lines.join("\n") }],
    });
  }
  return blocks;
};
