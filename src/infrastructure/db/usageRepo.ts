/**
 * What the model has cost, by person and by command.
 *
 * One row per finished run. The totals are computed in SQL rather than kept as
 * running counters: a counter that drifts is worse than no counter, and the
 * table is small enough that summing it is free.
 *
 * `costUsd` is the CLI's list-price figure, which on a subscription credential
 * is consumption rather than an invoice. Every caller that shows it says so.
 */
import type { DbClient } from "./client.ts";

export type UsageEntry = {
  readonly slackUserId: string;
  /** `chat`, `workflow`, or the command's name. */
  readonly kind: string;
  readonly channelId: string;
  readonly model: string;
  /** Whose credential carried it. */
  readonly payer: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly costUsd: number;
  readonly durationMs: number;
};

/** One line of a breakdown: a person, or a command. */
export type UsageSlice = {
  readonly key: string;
  readonly runs: number;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly durationMs: number;
};

export type UsageTotals = Omit<UsageSlice, "key">;

type SliceRow = {
  key: string;
  runs: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  duration_ms: number;
};

const toSlice = (r: SliceRow): UsageSlice => ({
  key: r.key ?? "",
  runs: r.runs ?? 0,
  costUsd: r.cost_usd ?? 0,
  inputTokens: r.input_tokens ?? 0,
  outputTokens: r.output_tokens ?? 0,
  cacheRead: r.cache_read ?? 0,
  cacheWrite: r.cache_write ?? 0,
  durationMs: r.duration_ms ?? 0,
});

const SUMS = `COUNT(*) AS runs,
  COALESCE(SUM(cost_usd), 0) AS cost_usd,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read), 0) AS cache_read,
  COALESCE(SUM(cache_write), 0) AS cache_write,
  COALESCE(SUM(duration_ms), 0) AS duration_ms`;

export type UsageRepo = {
  add: (entry: UsageEntry, createdAt: number) => void;
  /** Everything since `since`, as one line. */
  totals: (since: number) => UsageTotals;
  /** Per person, dearest first. */
  byUser: (since: number, limit?: number) => UsageSlice[];
  /** Per command (`chat` and `workflow` included), dearest first. */
  byKind: (since: number, limit?: number) => UsageSlice[];
  count: () => number;
};

export const createUsageRepo = (db: DbClient): UsageRepo => {
  const insertStmt = db.query(
    `INSERT INTO llm_usage
       (slack_user_id, kind, channel_id, model, payer, input_tokens, output_tokens,
        cache_read, cache_write, cost_usd, duration_ms, created_at)
     VALUES ($slackUserId, $kind, $channelId, $model, $payer, $inputTokens, $outputTokens,
        $cacheRead, $cacheWrite, $costUsd, $durationMs, $createdAt)`,
  );
  const totalsStmt = db.query<SliceRow, [number]>(
    `SELECT '' AS key, ${SUMS} FROM llm_usage WHERE created_at >= ?`,
  );
  const byUserStmt = db.query<SliceRow, [number, number]>(
    `SELECT slack_user_id AS key, ${SUMS} FROM llm_usage
     WHERE created_at >= ? GROUP BY slack_user_id ORDER BY cost_usd DESC LIMIT ?`,
  );
  const byKindStmt = db.query<SliceRow, [number, number]>(
    `SELECT kind AS key, ${SUMS} FROM llm_usage
     WHERE created_at >= ? GROUP BY kind ORDER BY cost_usd DESC LIMIT ?`,
  );
  const countStmt = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM llm_usage");

  return {
    add: (entry, createdAt) => {
      insertStmt.run({
        $slackUserId: entry.slackUserId,
        $kind: entry.kind,
        $channelId: entry.channelId,
        $model: entry.model,
        $payer: entry.payer,
        $inputTokens: entry.inputTokens,
        $outputTokens: entry.outputTokens,
        $cacheRead: entry.cacheRead,
        $cacheWrite: entry.cacheWrite,
        $costUsd: entry.costUsd,
        $durationMs: entry.durationMs,
        $createdAt: createdAt,
      });
    },
    totals: (since) => {
      const { key: _key, ...rest } = toSlice(
        totalsStmt.get(since) ?? ({ key: "" } as SliceRow),
      );
      return rest;
    },
    byUser: (since, limit = 20) => byUserStmt.all(since, Math.max(1, limit)).map(toSlice),
    byKind: (since, limit = 20) => byKindStmt.all(since, Math.max(1, limit)).map(toSlice),
    count: () => countStmt.get()?.n ?? 0,
  };
};
