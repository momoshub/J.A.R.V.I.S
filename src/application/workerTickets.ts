/**
 * Scoped tickets for Orca workers, persisted by hash.
 *
 * A turn ticket cannot serve a worker: it dies in 20 minutes and carries the
 * caller's whole role, including `/api/commands/run`. A worker ticket is minted
 * by a turn (`worker-ticket`), for the actor of THAT turn's own ticket, and is
 * good for one repo and a short list of GitHub App actions only. It is its own
 * store, so `commandTickets.redeem` has never heard of it: it cannot run an X or
 * `jv` command, and a turn ticket is not a worker ticket either.
 *
 * Life cycle: `issue` (pending, 10 min) -> `bind` to the dispatch id once
 * `worker-start` has printed it -> redeemed per call -> `revoke` when that
 * worker finishes or dies, with the TTL (default 3h, max 6h, counted from the
 * bind) as the backstop. `renew` extends it, by an admin (`renew`, also after
 * it lapsed) or by the worker itself (`renewSelf`, only while it is live), at
 * most `WORKER_TTL_MAX_MS` per renewal and never past `WORKER_LIFETIME_MAX_MS`
 * from the bind. A bound ticket that merely LAPSED (its worker never ended, so
 * it was never revoked) therefore keeps its row and file until that absolute
 * limit, refused meanwhile but renewable; its GitHub token is revoked at the
 * lapse. The rows live in `worker_tickets` and survive a restart;
 * only the sha-256 of the token is stored. The token itself is written once to a
 * 0600 file (`WorkerTicketFiles`) that the brief names by path, so it is never in
 * the brain's context, a command result, a spec or a Slack message, and the file
 * is deleted when the ticket ends. `sweep` (boot, and on a timer) ends what
 * is over for good; every end (revoke, lapse, or the limit) also notifies `onEnd`
 * so the GitHub token minted for that ticket is revoked at GitHub.
 *
 * The token is never logged. `id` (first 8 hex of its sha-256) is what logs and
 * audit rows carry, and it is also how `bind`/`revoke` name a ticket without
 * the secret appearing in a command line.
 */
import { createHash } from "node:crypto";
import {
  COMMIT_IDENTITY,
  endedWorkerOf,
  HOUR_MS,
  mayPush,
  normRepo,
  PENDING_TTL_MS,
  RENEW_ACTION,
  WORKER_LIFETIME_MAX_MS,
  WORKER_TOKEN_PREFIX,
  WORKER_TTL_MAX_MS,
  type WorkerGrant,
} from "../domain/workerTicket.ts";
import type { WorkerTicketRepo, WorkerTicketRow } from "../infrastructure/db/workerTicketRepo.ts";
import type { Clock } from "./ports.ts";

/** Where a ticket's token is handed to the worker: a file only the bot's user can read. */
export type WorkerTicketFiles = {
  /** Write the token (mode 0600) and return the absolute path the worker is told. */
  write: (id: string, token: string) => string;
  /** Delete it; no error when it is gone. */
  remove: (id: string) => void;
};

export type WorkerTicketGrant = {
  /** The actor of the minting turn's ticket. */
  actor: string;
  channel: string;
  threadTs?: string;
  repo: string;
  actions: readonly WorkerGrant[];
  ttlMs: number;
};

export type WorkerRefusal = "unknown" | "expired" | "revoked" | "pending" | "action" | "repo";

/** What a redeem says; a refusal still names the ticket's owner when it is known, for the audit row. */
export type WorkerRedeem =
  | { readonly ok: true; readonly actor: string; readonly channel: string; readonly dispatchId: string; readonly id: string; readonly threadTs?: string; readonly push: boolean }
  | {
      readonly ok: false;
      readonly reason: WorkerRefusal;
      readonly message: string;
      readonly actor?: string;
      readonly channel?: string;
      readonly dispatchId?: string;
      readonly id?: string;
    };

/** What a renewal says. A refusal still names the ticket when it is known, for the audit row. */
export type WorkerRenewal =
  | {
      readonly ok: true;
      readonly id: string;
      readonly actor: string;
      readonly channel: string;
      readonly dispatchId: string;
      readonly expiresAt: number;
      /** What was added, counted from now. */
      readonly ttlMs: number;
      /** The asked TTL was over `WORKER_TTL_MAX_MS` and was cut to it. */
      readonly clamped: boolean;
      /** The renewal was cut short by the absolute lifetime. */
      readonly capped: boolean;
      /** It had already lapsed (an admin revived it). */
      readonly wasExpired: boolean;
    }
  | { readonly ok: false; readonly error: string; readonly id?: string; readonly actor?: string; readonly channel?: string; readonly dispatchId?: string };

export type WorkerTickets = {
  /** Mint a pending ticket. The token goes to its file only; `id` is the public handle, `file` the path. */
  issue: (grant: WorkerTicketGrant) => { id: string; file: string };
  /** Bind a pending ticket to its dispatch and start its TTL. Only the minting actor may. */
  bind: (id: string, actor: string, dispatchId: string) => { ok: true } | { ok: false; error: string };
  /** Resolve for one GitHub App call; checks the action and the repo against the grant. */
  redeem: (token: string, call: { action: string; repo: string }) => WorkerRedeem;
  /**
   * Extend a ticket by its id or every ticket of a `ctx_...` dispatch, to now +
   * ttl (never earlier than it already ran). Works after the TTL ran out while
   * the ticket was never revoked; refuses pending and revoked ones and anything
   * past the absolute lifetime. One result per ticket. Who may is the caller's
   * (admin) gate.
   */
  renew: (target: string, ttlMs: number) => WorkerRenewal[];
  /** A worker extends its OWN ticket: the same, but only while it is still valid. */
  renewSelf: (token: string, ttlMs: number) => WorkerRenewal;
  /** End every ticket of a dispatch; how many were live. */
  revoke: (dispatchId: string) => number;
  /** End one ticket by its id (only its minting actor); false when there is no such live ticket. */
  revokeId: (id: string, actor: string) => boolean;
  /** End what has expired (files, GitHub tokens, rows); how many. Run at boot and on a timer. */
  sweep: () => number;
  /** Be told the id of every ticket that ends (revoked or expired), to revoke what was minted for it. */
  onEnd: (fn: (id: string) => void) => void;
};

const LIMIT_HOURS = WORKER_LIFETIME_MAX_MS / HOUR_MS;

/** `good for 3h more (capped to 6h per renewal)`, for the audit row, the helper's answer and the command. */
export const renewalSummary = (r: Extract<WorkerRenewal, { ok: true }>, now: number): string => {
  const mins = Math.max(1, Math.round((r.expiresAt - now) / 60_000));
  const left = mins >= 120 && mins % 60 === 0 ? `${mins / 60}h` : mins >= 90 ? `${(mins / 60).toFixed(1)}h` : `${mins}m`;
  return [
    `ticket ${r.id} renewed: good for ${left} more`,
    r.clamped && `(a renewal adds at most ${WORKER_TTL_MAX_MS / HOUR_MS}h, so the ttl was clamped)`,
    r.capped && `(cut short: a ticket lives ${LIMIT_HOURS}h at most from its bind, so it cannot be renewed past this)`,
    r.wasExpired && "(it had expired and is live again)",
  ]
    .filter(Boolean)
    .join(" ");
};

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");
export const tokenId = (token: string): string => hashOf(token).slice(0, 8);

const GONE = "that worker ticket is not valid any more";

/** Bound tickets only: the absolute limit of its life, whatever the renewals. */
const lifetimeEnd = (r: WorkerTicketRow): number => r.boundAt + WORKER_LIFETIME_MAX_MS;

export type WorkerTicketDeps = {
  repo: WorkerTicketRepo;
  files: WorkerTicketFiles;
  newToken?: () => string;
};

export const createWorkerTickets = (
  clock: Clock,
  { repo, files, newToken = () => `${WORKER_TOKEN_PREFIX}${crypto.randomUUID().replaceAll("-", "")}` }: WorkerTicketDeps,
): WorkerTickets => {
  const listeners: Array<(id: string) => void> = [];
  const notify = (id: string): void => {
    for (const fn of listeners) {
      try {
        fn(id);
      } catch {
        // a failed GitHub revoke must not keep the ticket alive
      }
    }
  };
  /** Revoked: the row stays (so a redeem says "revoked") until it would have expired. */
  const end = (r: WorkerTicketRow): void => {
    repo.revoke(r.tokenHash, clock());
    files.remove(r.id);
    notify(r.id);
  };
  /**
   * Bound, never revoked and inside its absolute lifetime: if its TTL has run out
   * it is only lapsed, and an admin can still renew it (its worker may be alive).
   */
  const renewable = (r: WorkerTicketRow): boolean => r.dispatchId !== "" && r.revokedAt === undefined && clock() < lifetimeEnd(r);
  /** A lapsed ticket loses its GitHub token once; the row and the file stay for a renewal. */
  const lapsed = new Set<string>();
  const lapse = (r: WorkerTicketRow): void => {
    if (lapsed.has(r.id)) return;
    lapsed.add(r.id);
    notify(r.id);
  };
  const sweep = (): number => {
    const now = clock();
    let n = 0;
    for (const r of repo.expired(now)) {
      if (renewable(r)) {
        lapse(r);
        continue;
      }
      files.remove(r.id);
      if (r.revokedAt === undefined) notify(r.id);
      lapsed.delete(r.id);
      repo.delete(r.tokenHash);
      n++;
    }
    return n;
  };
  const liveById = (id: string): WorkerTicketRow | undefined => {
    const r = repo.byId(id);
    return r && r.revokedAt === undefined && r.expiresAt > clock() ? r : undefined;
  };
  /** Why this ticket cannot be used now, ending it when its life is over for good. */
  const standing = (e: WorkerTicketRow): { reason: "revoked" | "expired" | "pending"; message: string } | undefined => {
    if (e.revokedAt !== undefined) return { reason: "revoked", message: "that worker ticket was revoked when its worker ended" };
    if (e.expiresAt <= clock()) {
      if (renewable(e)) {
        lapse(e);
        return {
          reason: "expired",
          message: `that worker ticket has expired; ask for it to be renewed (\`worker-ticket renew ${e.id}\`) or for a new one`,
        };
      }
      end(e);
      return {
        reason: "expired",
        message: e.dispatchId
          ? `that worker ticket reached its ${LIMIT_HOURS}h lifetime limit; ask for a new one`
          : "that worker ticket has expired; ask for a new one",
      };
    }
    if (!e.dispatchId) {
      return { reason: "pending", message: "that worker ticket is not bound to its dispatch yet; retry in a few seconds" };
    }
    return undefined;
  };
  const extend = (e: WorkerTicketRow, askedMs: number): WorkerRenewal => {
    const now = clock();
    const who = { id: e.id, actor: e.actor, channel: e.channel, dispatchId: e.dispatchId };
    if (e.revokedAt !== undefined) {
      return { ok: false, error: `ticket ${e.id} was revoked (its worker ended or it was revoked); a revoked ticket cannot be renewed, mint a new one`, ...who };
    }
    if (!e.dispatchId) {
      return { ok: false, error: `ticket ${e.id} is not bound to a dispatch yet; bind it first (a pending ticket lapses in 10 minutes)`, ...who };
    }
    if (now >= lifetimeEnd(e)) {
      return { ok: false, error: `ticket ${e.id} reached its ${LIMIT_HOURS}h lifetime limit (counted from the bind); mint a new one`, ...who };
    }
    const ttlMs = Math.min(askedMs, WORKER_TTL_MAX_MS);
    const wanted = now + ttlMs;
    const expiresAt = Math.max(e.expiresAt, Math.min(wanted, lifetimeEnd(e)));
    repo.setExpiry(e.tokenHash, expiresAt);
    lapsed.delete(e.id);
    return {
      ok: true,
      ...who,
      expiresAt,
      ttlMs: expiresAt - now,
      clamped: askedMs > WORKER_TTL_MAX_MS,
      capped: wanted > lifetimeEnd(e),
      wasExpired: e.expiresAt <= now,
    };
  };

  return {
    issue: (grant) => {
      const now = clock();
      sweep();
      const token = newToken();
      const tokenHash = hashOf(token);
      const id = tokenHash.slice(0, 8);
      repo.insert({
        tokenHash,
        id,
        actor: grant.actor,
        channel: grant.channel,
        threadTs: grant.threadTs ?? "",
        repo: normRepo(grant.repo),
        actions: grant.actions,
        ttlMs: Math.min(grant.ttlMs, WORKER_TTL_MAX_MS),
        dispatchId: "",
        createdAt: now,
        boundAt: 0,
        expiresAt: now + PENDING_TTL_MS,
      });
      return { id, file: files.write(id, token) };
    },

    bind: (id, actor, dispatchId) => {
      sweep();
      const e = liveById(id);
      if (!e) return { ok: false, error: "no live pending worker ticket with that id" };
      if (e.actor !== actor) return { ok: false, error: "that worker ticket was minted by someone else" };
      if (e.dispatchId) return { ok: false, error: "that worker ticket is already bound to a dispatch" };
      const now = clock();
      repo.bind(e.tokenHash, dispatchId, now, now + e.ttlMs);
      return { ok: true };
    },

    redeem: (token, call) => {
      const e = repo.byHash(hashOf(token));
      if (!e) return { ok: false, reason: "unknown", message: GONE };
      const who = { actor: e.actor, channel: e.channel, dispatchId: e.dispatchId || undefined, id: e.id };
      const out = standing(e);
      if (out) return { ok: false, ...out, ...who };
      // Renewing one's own ticket is not a grant: every live ticket may, on its own repo.
      // `git-auth` is also what the commit identity is fetched with: allowed when either grant is held (`push` says which).
      const granted = call.action === "git-auth" ? e.actions.includes("git-auth") || e.actions.includes(COMMIT_IDENTITY) : e.actions.includes(call.action);
      if (call.action !== RENEW_ACTION && !granted) {
        return {
          ok: false,
          reason: "action",
          message: `a worker ticket does not allow \`${call.action}\` (allowed: ${e.actions.join(", ")})`,
          ...who,
        };
      }
      if (normRepo(call.repo) !== e.repo) {
        return { ok: false, reason: "repo", message: `a worker ticket is for ${e.repo} only, not ${call.repo}`, ...who };
      }
      return { ok: true, actor: e.actor, channel: e.channel, dispatchId: e.dispatchId, id: e.id, push: mayPush(e.actions), ...(e.threadTs ? { threadTs: e.threadTs } : {}) };
    },

    renew: (target, ttlMs) => {
      const rows = target.startsWith("ctx_") ? repo.liveOfDispatch(target) : [repo.byId(target)].filter((r) => r !== undefined);
      if (rows.length === 0) {
        return [{ ok: false, error: `no worker ticket for ${target} (it was revoked, or it reached its ${LIMIT_HOURS}h lifetime limit and was cleaned up); mint a new one` }];
      }
      return rows.map((r) => extend(r, ttlMs));
    },

    renewSelf: (token, ttlMs) => {
      const e = repo.byHash(hashOf(token));
      if (!e) return { ok: false, error: GONE };
      const out = standing(e);
      if (out) {
        const hint = out.reason === "expired" ? "; an expired ticket cannot renew itself" : "";
        return { ok: false, error: `${out.message}${hint}`, id: e.id, actor: e.actor, channel: e.channel, dispatchId: e.dispatchId };
      }
      return extend(e, ttlMs);
    },

    revoke: (dispatchId) => {
      const live = repo.liveOfDispatch(dispatchId);
      for (const e of live) end(e);
      return live.length;
    },

    revokeId: (id, actor) => {
      const e = repo.byId(id);
      if (!e || e.revokedAt !== undefined || e.actor !== actor) return false;
      if (e.expiresAt <= clock() && !renewable(e)) return false;
      end(e);
      return true;
    },

    sweep,
    onEnd: (fn) => void listeners.push(fn),
  };
};

/**
 * The watcher's `onFired` half that ends a worker's tickets: only a watch whose
 * check runs the worker helper counts (a hand-written shell watch printing the
 * same line revokes nothing), and only `finished`/`died` - a worker waiting on
 * input is still working. Returns how many tickets were revoked.
 */
export const revokeOnWorkerEnd =
  (tickets: Pick<WorkerTickets, "revoke">, helper: string) =>
  (watch: { readonly check: string }, output: string): number => {
    if (!helper || !watch.check.includes(helper)) return 0;
    const ended = endedWorkerOf(output);
    return ended ? tickets.revoke(ended) : 0;
  };
