/**
 * What an Orca worker cost: tokens summed from its Claude Code transcript and
 * priced per model.
 *
 * Orca records no tokens, no cost and no session id for a worker, so the only
 * place the number exists is the transcript Claude Code writes for the
 * worker's session (`~/.claude/projects/<cwd-slug>/<session>.jsonl`, plus
 * `<session>/subagents/*.jsonl` for the Agent tool's agents). Every assistant
 * line carries `message.usage` and `message.model`. Claude Code writes ONE
 * line per content block, each repeating the same message id and usage, so a
 * message is counted once (by `message.id`, else `requestId`, else the line's
 * own `uuid`), taking the largest value seen for each field.
 *
 * Pure: the caller reads the files. The figure is LIST price - on a
 * subscription credential nobody is invoiced it, same as `spend`.
 */

/** Token counts for one model. Cache writes are priced by TTL, so kept apart. */
export type TokenCounts = {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
};

export type ModelUsage = TokenCounts & {
  /** The model id as the transcript names it, `(fast)` appended for fast mode. */
  readonly model: string;
  /** Distinct API messages counted. */
  readonly messages: number;
};

/** Prices in USD per million tokens. Cache writes derive from `input`. */
export type ModelPrice = { readonly input: number; readonly output: number; readonly cacheRead: number };

/**
 * List prices, USD per million tokens (Anthropic first-party API, cached
 * 2026-09-25 in the claude-api skill). Cache writes are 1.25x input for the
 * 5-minute TTL and 2x for the 1-hour one; reads are 0.1x input unless a model
 * says otherwise. Matched EXACTLY once a date suffix or `[1m]` tag is dropped:
 * a newer model must never borrow an older one's price (`claude-opus-5-6` is
 * not `claude-opus-5`), it is named as unpriced until it is added here.
 * Keep this the ONE place prices live.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-mythos-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

/**
 * Fast mode is billed at a multiple of the standard price (Opus 5 / 5.5: 2x).
 * A model whose fast multiplier is not known here is unpriced in fast mode,
 * never priced at the standard rate.
 */
export const FAST_MULTIPLIER: Readonly<Record<string, number>> = {
  "claude-opus-5-5": 2,
  "claude-opus-5": 2,
};

export const CACHE_WRITE_5M = 1.25;
export const CACHE_WRITE_1H = 2;

const FAST_TAG = " (fast)";
/** The price-table key for a model id, or undefined when it has no price. */
export const priceKey = (model: string): string | undefined => {
  const bare = model
    .replace(FAST_TAG, "")
    .replace(/\[.*\]$/, "")
    .replace(/-\d{8}$/, "")
    .trim();
  return Object.hasOwn(MODEL_PRICES, bare) ? bare : undefined;
};

/** USD for one model's tokens, or undefined when the model has no price. */
export const priceOf = (u: ModelUsage): number | undefined => {
  const key = priceKey(u.model);
  if (!key) return undefined;
  const p = MODEL_PRICES[key]!;
  const fast = u.model.endsWith(FAST_TAG) ? FAST_MULTIPLIER[key] : 1;
  if (fast === undefined) return undefined;
  const usd =
    u.input * p.input +
    u.output * p.output +
    u.cacheWrite5m * p.input * CACHE_WRITE_5M +
    u.cacheWrite1h * p.input * CACHE_WRITE_1H +
    u.cacheRead * p.cacheRead;
  return (usd * fast) / 1_000_000;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

type Counted = { model: string } & { -readonly [K in keyof TokenCounts]: number };

/** One assistant line's counts, or undefined when it is not a billed message. */
const lineCounts = (line: Record<string, unknown>): { key: string; counts: Counted } | undefined => {
  if (line.type !== "assistant" || !isObj(line.message)) return undefined;
  const msg = line.message;
  const usage = isObj(msg.usage) ? msg.usage : undefined;
  const model = str(msg.model);
  // `<synthetic>` is what Claude Code writes for a message it made up itself
  // (an error notice): no request, no tokens.
  if (!usage || !model || model.startsWith("<")) return undefined;
  const key = str(msg.id) ?? str(line.requestId) ?? str(line.uuid);
  if (!key) return undefined;
  const write = num(usage.cache_creation_input_tokens);
  const split = isObj(usage.cache_creation) ? usage.cache_creation : undefined;
  const w1h = split ? num(split.ephemeral_1h_input_tokens) : 0;
  // A split that does not add up (older transcripts carry none) leaves the
  // rest at the 5-minute price, the cheaper and the API's default.
  const w5m = split ? Math.max(num(split.ephemeral_5m_input_tokens), write - w1h) : write;
  return {
    key,
    counts: {
      model: usage.speed === "fast" ? `${model}${FAST_TAG}` : model,
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheWrite5m: w5m,
      cacheWrite1h: w1h,
      cacheRead: num(usage.cache_read_input_tokens),
    },
  };
};

const FIELDS = ["input", "output", "cacheWrite5m", "cacheWrite1h", "cacheRead"] as const;

/**
 * Sum the usage in one or more transcript files' text, per model. A message
 * that appears in several files (a resumed session copies history) is still
 * counted once. Lines that do not parse are skipped.
 */
export const sumTranscripts = (texts: readonly string[]): ModelUsage[] => {
  const seen = new Map<string, Counted>();
  for (const text of texts) {
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isObj(parsed)) continue;
      const got = lineCounts(parsed);
      if (!got) continue;
      const prev = seen.get(got.key);
      if (!prev) {
        seen.set(got.key, got.counts);
        continue;
      }
      for (const f of FIELDS) prev[f] = Math.max(prev[f], got.counts[f]);
    }
  }
  const byModel = new Map<string, ModelUsage>();
  for (const c of seen.values()) {
    const prev = byModel.get(c.model);
    byModel.set(c.model, {
      model: c.model,
      messages: (prev?.messages ?? 0) + 1,
      input: (prev?.input ?? 0) + c.input,
      output: (prev?.output ?? 0) + c.output,
      cacheWrite5m: (prev?.cacheWrite5m ?? 0) + c.cacheWrite5m,
      cacheWrite1h: (prev?.cacheWrite1h ?? 0) + c.cacheWrite1h,
      cacheRead: (prev?.cacheRead ?? 0) + c.cacheRead,
    });
  }
  return [...byModel.values()].sort((a, b) => (priceOf(b) ?? 0) - (priceOf(a) ?? 0));
};

/** A worker's usage as stored and reported. */
export type WorkerUsage = {
  readonly dispatchId: string;
  readonly sessionId: string;
  readonly models: readonly ModelUsage[];
  /** USD at list price over the priced models; undefined when none is priced. */
  readonly costUsd: number | undefined;
  /** Models with no entry in `MODEL_PRICES`, left out of `costUsd`. */
  readonly unpriced: readonly string[];
  readonly runId?: string;
  /** When Orca dispatched it, epoch ms. */
  readonly startedAt?: number;
};

export const workerUsage = (dispatchId: string, sessionId: string, models: readonly ModelUsage[]): WorkerUsage => {
  let cost: number | undefined;
  const unpriced: string[] = [];
  for (const m of models) {
    const p = priceOf(m);
    if (p === undefined) unpriced.push(m.model);
    else cost = (cost ?? 0) + p;
  }
  return { dispatchId, sessionId, models, costUsd: cost, unpriced };
};

export const totals = (models: readonly ModelUsage[]): TokenCounts & { readonly all: number } => {
  const t = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
  for (const m of models) for (const f of FIELDS) t[f] += m[f];
  return { ...t, all: t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead };
};

/** 1234 -> "1.2k", 3_400_000 -> "3.4M". */
export const shortCount = (n: number): string => {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
};

export const usd = (n: number): string => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

/**
 * One human line: "1.24M tokens (in 3.1k, out 52k, cache write 140k, cache
 * read 1.05M), $4.21 at list price, claude-opus-5-5".
 */
export const usageSummary = (u: Pick<WorkerUsage, "models" | "costUsd" | "unpriced">): string => {
  if (u.models.length === 0) return "no billed messages in its transcript";
  const t = totals(u.models);
  const tokens = `${shortCount(t.all)} tokens (in ${shortCount(t.input)}, out ${shortCount(t.output)}, cache write ${shortCount(t.cacheWrite5m + t.cacheWrite1h)}, cache read ${shortCount(t.cacheRead)})`;
  const cost = u.costUsd === undefined ? "no price known" : `${usd(u.costUsd)} at list price`;
  const missing = u.unpriced.length > 0 && u.costUsd !== undefined ? ` (not counting ${u.unpriced.join(", ")}, no price known)` : "";
  return `${tokens}, ${cost}${missing}, ${u.models.map((m) => m.model).join(" + ")}`;
};

/**
 * The line `bin/orca-worker-wait.ts` prints after a worker ends, which the
 * hand-back reads back and the watcher stores: `orca worker <id> usage <json>`.
 */
export const workerUsageLine = (u: WorkerUsage): string =>
  `orca worker ${u.dispatchId} usage ${JSON.stringify({
    sessionId: u.sessionId,
    ...(u.runId ? { runId: u.runId } : {}),
    ...(u.startedAt ? { startedAt: u.startedAt } : {}),
    models: u.models,
  })}`;

const USAGE_LINE = /^orca worker (ctx_[A-Za-z0-9_-]+) usage (\{.*\})$/m;

const asModel = (v: unknown): ModelUsage | undefined => {
  if (!isObj(v) || !str(v.model)) return undefined;
  return {
    model: str(v.model)!,
    messages: num(v.messages),
    input: num(v.input),
    output: num(v.output),
    cacheWrite5m: num(v.cacheWrite5m),
    cacheWrite1h: num(v.cacheWrite1h),
    cacheRead: num(v.cacheRead),
  };
};

/** Read a usage line back out of a check's output; prices are recomputed. */
export const parseWorkerUsageLine = (output: string): WorkerUsage | undefined => {
  const m = output.match(USAGE_LINE);
  if (!m) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[2]!);
  } catch {
    return undefined;
  }
  if (!isObj(parsed) || !Array.isArray(parsed.models)) return undefined;
  const models = parsed.models.map(asModel).filter((x): x is ModelUsage => x !== undefined);
  const runId = str(parsed.runId);
  const startedAt = num(parsed.startedAt);
  return {
    ...workerUsage(m[1]!, str(parsed.sessionId) ?? "", models),
    ...(runId ? { runId } : {}),
    ...(startedAt ? { startedAt } : {}),
  };
};

/** The project folder name Claude Code files a session under: every non-alphanumeric is `-`. */
export const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, "-");
