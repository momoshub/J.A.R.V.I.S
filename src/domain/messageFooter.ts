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
import { SECTION_LIMIT } from "./slackFormat.ts";

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
  stuckSweeper: "stuck-work sweeper",
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

const FENCE = /^\s*```/;
const FENCE_ROOM = 8; // "```\n" reopened at the top of a chunk + "\n```" closing it

/**
 * Text cut into section-sized chunks that Slack will take. Unlike
 * `splitForBlocks` (which passes a long line through whole), nothing here may
 * exceed the limit, since one refused section loses the whole message: a line
 * longer than that is hard-cut. A code fence crossing a cut is closed at the
 * end of one chunk and reopened at the top of the next, so it still renders
 * as code rather than stray backticks.
 */
export const sectionChunks = (text: string, limit: number = SECTION_LIMIT): string[] => {
  const width = Math.max(1, limit - FENCE_ROOM);
  const lines = text
    .split("\n")
    .flatMap((l) => (l.length <= width ? [l] : Array.from({ length: Math.ceil(l.length / width) }, (_, i) => l.slice(i * width, (i + 1) * width))));
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  let inFence = false;
  const flush = () => {
    chunks.push(inFence ? `${current.join("\n")}\n\`\`\`` : current.join("\n"));
    current = inFence ? ["```"] : [];
    size = inFence ? 3 : 0;
  };
  for (const line of lines) {
    // Inside a fence, leave room for the "\n```" a cut adds - except on the
    // line that closes the fence itself, which needs none.
    const closes = inFence && FENCE.test(line);
    const grown = size + (current.length ? 1 : 0) + line.length + (inFence && !closes ? 4 : 0);
    if (grown > limit && current.length > (inFence ? 1 : 0)) flush();
    size += (current.length ? 1 : 0) + line.length;
    current.push(line);
    if (FENCE.test(line)) inFence = !inFence;
  }
  if (current.join("\n").trim() && !(current.length === 1 && current[0] === "```" && chunks.length)) chunks.push(current.join("\n"));
  return chunks.filter((c) => c.trim());
};

/**
 * A plain mrkdwn post as blocks, so it can carry the footer: one section per
 * chunk (`sectionChunks`, every one under Slack's 3000), then the footer.
 */
export const signedText = (mrkdwn: string, line: string): { text: string; blocks: Block[] } => ({
  text: mrkdwn || " ",
  blocks: withFooter(
    sectionChunks(mrkdwn).map((chunk) => ({ type: "section", text: { type: "mrkdwn", text: chunk } })),
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
  // A message already at Slack's 50 keeps every block it has: losing the
  // settled note or the buttons is worse than a missing footer.
  if (at < 0 && blocks.length >= MAX_BLOCKS) return [...blocks];
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
