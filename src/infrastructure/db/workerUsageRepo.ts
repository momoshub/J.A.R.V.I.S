/**
 * What each Orca worker used, by dispatch id (`orca_worker_usage`).
 *
 * The transcript stays on disk for a while but Orca forgets a dispatch, and
 * without Orca the dispatch -> session link is lost. So the link and the last
 * measurement are kept here: a later `worker-cost` can still answer, and a Run
 * can be totalled from what its workers were measured at.
 */
import type { DbClient } from "./client.ts";
import { totals, workerUsage, type ModelUsage, type WorkerUsage } from "../../domain/workerUsage.ts";

export type StoredWorkerUsage = WorkerUsage & { readonly measuredAt: number };

export type WorkerUsageRepo = {
  /** Insert or replace the measurement for a dispatch. */
  save: (u: WorkerUsage, at: number) => void;
  get: (dispatchId: string) => StoredWorkerUsage | undefined;
  /** Every worker measured in a Run, oldest first. */
  inRun: (runId: string) => StoredWorkerUsage[];
};

type Row = {
  dispatch_id: string;
  run_id: string;
  session_id: string;
  started_at: number | null;
  models: string;
  measured_at: number;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const parseModels = (text: string): ModelUsage[] => {
  try {
    const p: unknown = JSON.parse(text);
    if (!Array.isArray(p)) return [];
    return p.filter(isObj).flatMap((m) =>
      typeof m.model === "string"
        ? [
            {
              model: m.model,
              messages: n(m.messages),
              input: n(m.input),
              output: n(m.output),
              cacheWrite5m: n(m.cacheWrite5m),
              cacheWrite1h: n(m.cacheWrite1h),
              cacheRead: n(m.cacheRead),
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
};

// Prices are recomputed from the tokens on read, so a corrected price table
// applies to old rows too; `cost_usd` is kept for anyone reading the DB raw.
const fromRow = (r: Row): StoredWorkerUsage => ({
  ...workerUsage(r.dispatch_id, r.session_id, parseModels(r.models)),
  ...(r.run_id ? { runId: r.run_id } : {}),
  ...(r.started_at ? { startedAt: r.started_at } : {}),
  measuredAt: r.measured_at,
});

export const createWorkerUsageRepo = (db: DbClient): WorkerUsageRepo => {
  const saveStmt = db.query(
    `INSERT OR REPLACE INTO orca_worker_usage
       (dispatch_id, run_id, session_id, started_at, models, tokens, cost_usd, measured_at)
     VALUES ($dispatchId, $runId, $sessionId, $startedAt, $models, $tokens, $cost, $at)`,
  );
  const cols = "dispatch_id, run_id, session_id, started_at, models, measured_at";
  const getStmt = db.query<Row, [string]>(`SELECT ${cols} FROM orca_worker_usage WHERE dispatch_id = ?`);
  const runStmt = db.query<Row, [string]>(
    `SELECT ${cols} FROM orca_worker_usage WHERE run_id = ? ORDER BY COALESCE(started_at, measured_at)`,
  );
  return {
    save: (u, at) =>
      void saveStmt.run({
        $dispatchId: u.dispatchId,
        $runId: u.runId ?? "",
        $sessionId: u.sessionId,
        $startedAt: u.startedAt ?? null,
        $models: JSON.stringify(u.models),
        $tokens: totals(u.models).all,
        $cost: u.costUsd ?? null,
        $at: at,
      }),
    get: (dispatchId) => {
      const r = getStmt.get(dispatchId);
      return r ? fromRow(r) : undefined;
    },
    inRun: (runId) => runStmt.all(runId).map(fromRow),
  };
};
