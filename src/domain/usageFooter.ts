/**
 * The small grey line under a reply: which model answered, what it read and
 * wrote, what that came to, and how long it took.
 *
 * Asked for after another bot in the workspace showed one - a context block
 * under the answer, out of the way of the text but there for anyone who wants
 * to know what a turn cost. Kept to one line on purpose: model, tokens, cost,
 * time, nothing else.
 *
 * Cost is the CLI's LIST-price figure (see `LlmUsage`), so it reads as an
 * estimate of consumption, not a bill.
 */
export type FooterUsage = {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
};

/** 950 -> "950", 95_900 -> "95.9k", 1_620_400 -> "1.62M". */
export const compactTokens = (n: number): string => {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
};

/** 196_000 -> "3m 16s", 42_000 -> "0m 42s". Always minutes and seconds. */
export const minSec = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}m ${total % 60}s`;
};

/** One line: `claude-opus-5-5 · in 95.9k · out 10.6k · cache 1.62M · $1.30 · 3m 16s`. */
export const usageFooter = (u: FooterUsage): string =>
  [
    u.model || "unknown model",
    `in ${compactTokens(u.inputTokens)}`,
    `out ${compactTokens(u.outputTokens)}`,
    `cache ${compactTokens(u.cacheReadTokens + u.cacheWriteTokens)}`,
    `$${u.costUsd.toFixed(2)}`,
    minSec(u.durationMs),
  ].join(" · ");

/** The footer as a Slack context block, appended under the reply. */
export const usageFooterBlock = (u: FooterUsage) => ({
  type: "context" as const,
  elements: [{ type: "mrkdwn" as const, text: usageFooter(u) }],
});
