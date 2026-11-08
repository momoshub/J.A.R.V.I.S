/**
 * The grey line under every message this process writes: who wrote it, and
 * when it last changed.
 *
 * Asked for by Kai after a thread filled with messages from Jarvis, the inner
 * child, a watch firing and a reminder, all under the same bot name - there was
 * no telling which part of the process had said what. So every message carries
 * a signature, and since Jarvis edits its own messages later (a turn tidied, a
 * drain notice counted down, a question settled) it also says when that last
 * happened.
 *
 * One line, always: `Jarvis · <usage, when a turn reported it> · updated <time>`.
 * The time is a Slack date token, so each reader sees it in their own timezone;
 * the fallback (for clients that cannot render it) is the host clock with its
 * offset.
 *
 * The footer is a context block with a fixed `block_id`, which is how an edit
 * finds it again: restamping replaces only the time and keeps the signature,
 * the usage and any step summary sitting in the same block.
 */
import { type Block, MAX_BLOCKS } from "./blockKit.ts";
import { splitForBlocks } from "./slackFormat.ts";

/** Who signs what. Anything not listed here is plain Jarvis. */
export const SIGNATURES = {
  jarvis: "Jarvis",
  innerChild: "inner child Jarvis",
  workflowWorker: "workflow worker",
  workflowFront: "workflow front",
  command: "command",
  watch: "watch",
  reminder: "reminder",
  reviewInbox: "review inbox",
  githubApp: "GitHub app",
  offlineAlarm: "offline alarm",
} as const;

/** Marks the footer's context block, so an edit can find and restamp it. */
export const FOOTER_BLOCK_ID = "jv_footer";

const pad = (n: number): string => String(n).padStart(2, "0");

/** 420 -> "+07", -330 -> "-05:30", 0 -> "+00". Minutes east of UTC. */
export const offsetLabel = (offsetMin: number): string => {
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(Math.round(offsetMin));
  const mins = abs % 60;
  return `${sign}${pad(Math.floor(abs / 60))}${mins ? `:${pad(mins)}` : ""}`;
};

/** The host's offset east of UTC at `ms`, in minutes (DST-aware). */
export const hostOffsetMin = (ms: number): number => -new Date(ms).getTimezoneOffset();

/** "2026-11-08 14:32 +07": wall-clock time at the given offset. */
export const clockFallback = (ms: number, offsetMin: number): string => {
  const d = new Date(ms + offsetMin * 60_000);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} ${offsetLabel(offsetMin)}`;
};

/** `updated <!date^1794123692^{date_short_pretty} {time}|2026-11-08 14:32 +07>`. */
export const updatedStamp = (ms: number, offsetMin: number = hostOffsetMin(ms)): string =>
  `updated <!date^${Math.floor(ms / 1000)}^{date_short_pretty} {time}|${clockFallback(ms, offsetMin)}>`;

const STAMP = /updated <!date\^\d+\^[^|>]*\|[^>]*>/;

/**
 * The whole line: signature, then what the turn reported (model, tokens, cost,
 * time), then when it was last written.
 */
export const footerLine = (by: string, ms: number, detail?: string, offsetMin?: number): string =>
  [by.trim() || SIGNATURES.jarvis, detail?.trim(), updatedStamp(ms, offsetMin)].filter(Boolean).join(" · ");

/** The footer as its own context block. */
export const footerBlock = (line: string): Block => ({
  type: "context",
  block_id: FOOTER_BLOCK_ID,
  elements: [{ type: "mrkdwn", text: line }],
});

/** Any block shape: Slack hands blocks back as loose records. */
type AnyBlock = Record<string, unknown>;

const isFooter = (b: AnyBlock): boolean => b.block_id === FOOTER_BLOCK_ID;

/**
 * `blocks` with the footer at the end. A footer already there is replaced, not
 * stacked, and the content is clipped so the footer still fits Slack's 50.
 */
export const withFooter = <T extends AnyBlock>(blocks: readonly T[], line: string): (T | Block)[] => [
  ...blocks.filter((b) => !isFooter(b)).slice(0, MAX_BLOCKS - 1),
  footerBlock(line),
];

/**
 * A plain mrkdwn post as blocks, so it can carry the footer: one section per
 * chunk (Slack refuses a section over 3000 chars), then the footer.
 */
export const signedText = (mrkdwn: string, line: string): { text: string; blocks: Block[] } => ({
  text: mrkdwn || " ",
  blocks: withFooter(
    splitForBlocks(mrkdwn).filter((c) => c.trim()).map((chunk) => ({ type: "section", text: { type: "mrkdwn", text: chunk } })),
    line,
  ),
});

/**
 * The same message after an edit at `ms`: the footer's time moves on and
 * everything else in it stays. A message with no footer yet (one the model
 * posted itself) gets one signed `by`.
 */
export const restamp = <T extends AnyBlock>(
  blocks: readonly T[],
  by: string,
  ms: number,
  offsetMin?: number,
): (T | Block)[] => {
  const at = blocks.findIndex(isFooter);
  if (at < 0) return withFooter(blocks, footerLine(by, ms, undefined, offsetMin));
  const footer = blocks[at]!;
  const elements = Array.isArray(footer.elements) ? (footer.elements as Record<string, unknown>[]) : [];
  const last = elements.at(-1);
  const text = typeof last?.text === "string" ? last.text : "";
  const stamp = updatedStamp(ms, offsetMin);
  const next = !text.trim()
    ? footerLine(by, ms, undefined, offsetMin)
    : STAMP.test(text)
      ? text.replace(STAMP, stamp)
      : `${text} · ${stamp}`;
  const restamped: AnyBlock = {
    ...footer,
    elements: [...elements.slice(0, -1), { type: "mrkdwn", text: next }],
  };
  return blocks.map((b, i) => (i === at ? (restamped as T) : b));
};
