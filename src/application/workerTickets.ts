/**
 * Scoped tickets for Orca workers, held in memory.
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
 * bind) as the backstop. In memory on purpose: a restart loses the tickets and
 * the worker reports it cannot push, which is a safe failure and a one-line fix
 * (mint again), whereas a persisted bearer token would have to be hashed, swept
 * and revoked across restarts for a window of a few hours.
 *
 * The token is never logged. `id` (first 8 hex of its sha-256) is what logs and
 * audit rows carry, and it is also how `bind`/`revoke` name a ticket without
 * the secret appearing in a command line.
 */
import { createHash } from "node:crypto";
import type { ActionName } from "../domain/githubAppAction.ts";
import { endedWorkerOf, normRepo, PENDING_TTL_MS, WORKER_TOKEN_PREFIX, WORKER_TTL_MAX_MS } from "../domain/workerTicket.ts";
import type { Clock } from "./ports.ts";

export type WorkerTicketGrant = {
  /** The actor of the minting turn's ticket. */
  actor: string;
  channel: string;
  threadTs?: string;
  repo: string;
  actions: readonly ActionName[];
  ttlMs: number;
};

export type WorkerRefusal = "unknown" | "expired" | "revoked" | "pending" | "action" | "repo";

/** What a redeem says; a refusal still names the ticket's owner when it is known, for the audit row. */
export type WorkerRedeem =
  | { readonly ok: true; readonly actor: string; readonly channel: string; readonly dispatchId: string; readonly id: string }
  | {
      readonly ok: false;
      readonly reason: WorkerRefusal;
      readonly message: string;
      readonly actor?: string;
      readonly channel?: string;
      readonly dispatchId?: string;
      readonly id?: string;
    };

export type WorkerTickets = {
  /** Mint a pending ticket. The token goes to the brain once; `id` is the public handle. */
  issue: (grant: WorkerTicketGrant) => { token: string; id: string };
  /** Bind a pending ticket to its dispatch and start its TTL. Only the minting actor may. */
  bind: (id: string, actor: string, dispatchId: string) => { ok: true } | { ok: false; error: string };
  /** Resolve for one GitHub App call; checks the action and the repo against the grant. */
  redeem: (token: string, call: { action: string; repo: string }) => WorkerRedeem;
  /** End every ticket of a dispatch; how many were live. */
  revoke: (dispatchId: string) => number;
  /** End one ticket by its id (only its minting actor); false when there is no such live ticket. */
  revokeId: (id: string, actor: string) => boolean;
};

type Entry = WorkerTicketGrant & {
  id: string;
  dispatchId?: string;
  expiresAt: number;
  revoked: boolean;
};

export const tokenId = (token: string): string => createHash("sha256").update(token).digest("hex").slice(0, 8);

const GONE = "that worker ticket is not valid any more";

export const createWorkerTickets = (
  clock: Clock,
  newToken: () => string = () => `${WORKER_TOKEN_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`,
): WorkerTickets => {
  const live = new Map<string, Entry>();

  const sweep = (now: number): void => {
    for (const [token, e] of live) if (e.expiresAt <= now) live.delete(token);
  };
  const byId = (id: string): Entry | undefined => [...live.values()].find((e) => e.id === id);

  return {
    issue: (grant) => {
      const now = clock();
      sweep(now);
      const token = newToken();
      const id = tokenId(token);
      live.set(token, {
        ...grant,
        repo: normRepo(grant.repo),
        ttlMs: Math.min(grant.ttlMs, WORKER_TTL_MAX_MS),
        id,
        expiresAt: now + PENDING_TTL_MS,
        revoked: false,
      });
      return { token, id };
    },

    bind: (id, actor, dispatchId) => {
      const now = clock();
      sweep(now);
      const e = byId(id);
      if (!e || e.revoked) return { ok: false, error: "no live pending worker ticket with that id" };
      if (e.actor !== actor) return { ok: false, error: "that worker ticket was minted by someone else" };
      if (e.dispatchId) return { ok: false, error: "that worker ticket is already bound to a dispatch" };
      e.dispatchId = dispatchId;
      e.expiresAt = now + e.ttlMs;
      return { ok: true };
    },

    redeem: (token, call) => {
      const e = live.get(token);
      if (!e) return { ok: false, reason: "unknown", message: GONE };
      const who = { actor: e.actor, channel: e.channel, dispatchId: e.dispatchId, id: e.id };
      if (e.expiresAt <= clock()) {
        live.delete(token);
        return { ok: false, reason: "expired", message: "that worker ticket has expired; ask for a new one", ...who };
      }
      if (e.revoked) return { ok: false, reason: "revoked", message: "that worker ticket was revoked when its worker ended", ...who };
      if (!e.dispatchId) {
        return { ok: false, reason: "pending", message: "that worker ticket is not bound to its dispatch yet; retry in a few seconds", ...who };
      }
      if (!(e.actions as readonly string[]).includes(call.action)) {
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
      return { ok: true, actor: e.actor, channel: e.channel, dispatchId: e.dispatchId, id: e.id };
    },

    revoke: (dispatchId) => {
      let n = 0;
      for (const e of live.values()) {
        if (e.dispatchId === dispatchId && !e.revoked) {
          e.revoked = true;
          n += 1;
        }
      }
      return n;
    },

    revokeId: (id, actor) => {
      const e = byId(id);
      if (!e || e.revoked || e.actor !== actor) return false;
      e.revoked = true;
      return true;
    },
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
