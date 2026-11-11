/**
 * Worker tickets on disk: the sha-256 of each bearer token and what it grants,
 * never the token. See `application/workerTickets.ts` for the rules.
 */
import type { DbClient } from "./client.ts";

export type WorkerTicketRow = {
  readonly tokenHash: string;
  /** First 8 hex of `tokenHash`: the handle logs and commands use. */
  readonly id: string;
  readonly actor: string;
  readonly channel: string;
  readonly threadTs: string;
  readonly repo: string;
  readonly actions: readonly string[];
  readonly ttlMs: number;
  /** Empty while pending. */
  readonly dispatchId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt?: number;
};

export type WorkerTicketRepo = {
  insert: (row: WorkerTicketRow) => void;
  byHash: (tokenHash: string) => WorkerTicketRow | undefined;
  byId: (id: string) => WorkerTicketRow | undefined;
  /** Every ticket of a dispatch that is not revoked yet. */
  liveOfDispatch: (dispatchId: string) => WorkerTicketRow[];
  bind: (tokenHash: string, dispatchId: string, expiresAt: number) => void;
  revoke: (tokenHash: string, at: number) => void;
  /** Rows that expired at or before `now`, revoked or not. */
  expired: (now: number) => WorkerTicketRow[];
  delete: (tokenHash: string) => void;
};

type Row = {
  token_hash: string;
  id: string;
  actor: string;
  channel: string;
  thread_ts: string;
  repo: string;
  actions: string;
  ttl_ms: number;
  dispatch_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
};

const parseActions = (v: string): string[] => {
  try {
    const a: unknown = JSON.parse(v);
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const fromRow = (r: Row): WorkerTicketRow => ({
  tokenHash: r.token_hash,
  id: r.id,
  actor: r.actor,
  channel: r.channel,
  threadTs: r.thread_ts,
  repo: r.repo,
  actions: parseActions(r.actions),
  ttlMs: r.ttl_ms,
  dispatchId: r.dispatch_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  ...(r.revoked_at === null ? {} : { revokedAt: r.revoked_at }),
});

export const createWorkerTicketRepo = (db: DbClient): WorkerTicketRepo => {
  const insertStmt = db.query(
    `INSERT INTO worker_tickets (token_hash, id, actor, channel, thread_ts, repo, actions, ttl_ms, dispatch_id, created_at, expires_at)
     VALUES ($hash, $id, $actor, $channel, $ts, $repo, $actions, $ttl, $dispatch, $created, $expires)`,
  );
  const hashStmt = db.query<Row, [string]>("SELECT * FROM worker_tickets WHERE token_hash = ?");
  const idStmt = db.query<Row, [string]>("SELECT * FROM worker_tickets WHERE id = ? ORDER BY created_at DESC LIMIT 1");
  const dispatchStmt = db.query<Row, [string]>(
    "SELECT * FROM worker_tickets WHERE dispatch_id = ? AND revoked_at IS NULL",
  );
  const bindStmt = db.query(
    "UPDATE worker_tickets SET dispatch_id = $dispatch, expires_at = $expires WHERE token_hash = $hash",
  );
  const revokeStmt = db.query("UPDATE worker_tickets SET revoked_at = $at WHERE token_hash = $hash AND revoked_at IS NULL");
  const expiredStmt = db.query<Row, [number]>("SELECT * FROM worker_tickets WHERE expires_at <= ?");
  const deleteStmt = db.query("DELETE FROM worker_tickets WHERE token_hash = ?");

  return {
    insert: (r) =>
      void insertStmt.run({
        $hash: r.tokenHash,
        $id: r.id,
        $actor: r.actor,
        $channel: r.channel,
        $ts: r.threadTs,
        $repo: r.repo,
        $actions: JSON.stringify(r.actions),
        $ttl: r.ttlMs,
        $dispatch: r.dispatchId,
        $created: r.createdAt,
        $expires: r.expiresAt,
      }),
    byHash: (h) => {
      const r = hashStmt.get(h);
      return r ? fromRow(r) : undefined;
    },
    byId: (id) => {
      const r = idStmt.get(id);
      return r ? fromRow(r) : undefined;
    },
    liveOfDispatch: (d) => dispatchStmt.all(d).map(fromRow),
    bind: (hash, dispatch, expires) => void bindStmt.run({ $hash: hash, $dispatch: dispatch, $expires: expires }),
    revoke: (hash, at) => void revokeStmt.run({ $hash: hash, $at: at }),
    expired: (now) => expiredStmt.all(now).map(fromRow),
    delete: (h) => void deleteStmt.run(h),
  };
};
