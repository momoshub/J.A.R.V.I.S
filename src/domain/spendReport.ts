/**
 * What the model has cost, written out for Slack.
 *
 * The figure is the CLI's own list price. On a subscription credential nobody
 * is invoiced it, so the report says "list price" every single time rather than
 * letting a number that looks like a bill be read as one - the difference
 * between "we spent $48 yesterday" and "we consumed $48 of list-price model
 * time yesterday" is the difference between a panic and a plan.
 *
 * A run that could not say whose it was is shown as "unattributed" rather than
 * dropped: the total has to add up, or the breakdown is worth nothing.
 */

export type SpendSlice = {
  readonly key: string;
  readonly runs: number;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly durationMs: number;
};

export type SpendTotals = Omit<SpendSlice, "key">;

/** Compact token count: 1_234_567 -> "1.2M". */
export const tokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
};

/** Dollars, never rounded to nothing: a tenth of a cent still reads as money. */
export const money = (usd: number): string =>
  usd >= 100 ? `$${Math.round(usd)}` : usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;

const hours = (ms: number): string => {
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}`;
};

const runs = (n: number): string => `${n} run${n === 1 ? "" : "s"}`;

/** How long the window is, in the words someone would use for it. */
export const windowLabel = (ms: number): string => {
  const days = Math.round(ms / 86_400_000);
  if (days >= 2) return `last ${days} days`;
  const hrs = Math.round(ms / 3_600_000);
  return hrs >= 48 ? `last ${Math.round(hrs / 24)} days` : `last ${hrs}h`;
};

const nameOf = (key: string, names: ReadonlyMap<string, string>): string =>
  key ? (names.get(key) ?? `<@${key}>`) : "unattributed";

/**
 * The report. Both breakdowns are shown because they answer different
 * questions: who is spending it, and what on.
 */
export const spendReport = (
  totals: SpendTotals,
  byUser: readonly SpendSlice[],
  byKind: readonly SpendSlice[],
  windowMs: number,
  names: ReadonlyMap<string, string> = new Map(),
): string => {
  const when = windowLabel(windowMs);
  if (totals.runs === 0) return `nothing has run in the ${when}`;

  const cached = totals.cacheRead + totals.cacheWrite;
  const lines = [
    `*${money(totals.costUsd)}* over the ${when}, list price - ${runs(totals.runs)}, ${hours(totals.durationMs)} of model time`,
    `tokens: ${tokens(totals.inputTokens)} in, ${tokens(totals.outputTokens)} out, ${tokens(cached)} cached`,
    "",
    "*by person*",
    ...byUser.map((u) => `- ${nameOf(u.key, names)} - ${money(u.costUsd)}, ${runs(u.runs)}`),
    "",
    "*by command*",
    ...byKind.map((k) => `- ${k.key || "chat"} - ${money(k.costUsd)}, ${runs(k.runs)}`),
  ];
  return lines.join("\n");
};
