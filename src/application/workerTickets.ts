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
 * bind) as the backstop. The rows live in `worker_tickets` and survive a restart;
 * only the sha-256 of the token is stored. The token itself is written once to a
 * 0600 file (`WorkerTicketFiles`) that the brief names by path, so it is never in
 * the brain's context, a command result, a spec or a Slack message, and the file
 * is deleted when the ticket ends. `sweep` (boot, and on a timer) ends what
 * expired; every end (revoke or expiry) also notifies `onEnd` so the GitHub token
 * minted for that ticket is revoked at GitHub.
 *
 * The token is never logged. `id` (first 8 hex of its sha-256) is what logs and
 * audit rows carry, and it is also how `bind`/`revoke` name a ticket without
 * the secret appearing in a command line.
 */
import { createHash } from "node:crypto";
import type { ActionName } from "../domain/githubAppAction.ts";
import { endedWorkerOf, normRepo, PENDING_TTL_MS, WORKER_TOKEN_PREFIX, WORKER_TTL_MAX_MS } from "../domain/workerTicket.ts";
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
  /** Mint a pending ticket. The token goes to its file only; `id` is the public handle, `file` the path. */
  issue: (grant: WorkerTicketGrant) => { id: string; file: string };
  /** Bind a pending ticket to its dispatch and start its TTL. Only the minting actor may. */
  bind: (id: string, actor: string, dispatchId: string) => { ok: true } | { ok: false; error: string };
  /** Resolve for one GitHub App call; checks the action and the repo against the grant. */
  redeem: (token: string, call: { action: string; repo: string }) => WorkerRedeem;
  /** End every ticket of a dispatch; how many were live. */
  revoke: (dispatchId: string) => number;
  /** End one ticket by its id (only its minting actor); false when there is no such live ticket. */
  revokeId: (id: string, actor: string) => boolean;
  /** End what has expired (files, GitHub tokens, rows); how many. Run at boot and on a timer. */
  sweep: () => number;
  /** Be told the id of every ticket that ends (revoked or expired), to revoke what was minted for it. */
  onEnd: (fn: (id: string) => void) => void;
};

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");
export const tokenId = (token: string): string => hashOf(token).slice(0, 8);

const GONE = "that worker ticket is not valid any more";

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
  const sweep = (): number => {
    const now = clock();
    const gone = repo.expired(now);
    for (const r of gone) {
      files.remove(r.id);
      if (r.revokedAt === undefined) notify(r.id);
      repo.delete(r.tokenHash);
    }
    return gone.length;
  };
  const liveById = (id: string): WorkerTicketRow | undefined => {
    const r = repo.byId(id);
    return r && r.revokedAt === undefined && r.expiresAt > clock() ? r : undefined;
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
      repo.bind(e.tokenHash, dispatchId, clock() + e.ttlMs);
      return { ok: true };
    },

    redeem: (token, call) => {
      const e = repo.byHash(hashOf(token));
      if (!e) return { ok: false, reason: "unknown", message: GONE };
      const who = { actor: e.actor, channel: e.channel, dispatchId: e.dispatchId || undefined, id: e.id };
      if (e.revokedAt !== undefined) {
        return { ok: false, reason: "revoked", message: "that worker ticket was revoked when its worker ended", ...who };
      }
      if (e.expiresAt <= clock()) {
        end(e);
        return { ok: false, reason: "expired", message: "that worker ticket has expired; ask for a new one", ...who };
      }
      if (!e.dispatchId) {
        return { ok: false, reason: "pending", message: "that worker ticket is not bound to its dispatch yet; retry in a few seconds", ...who };
      }
      if (!e.actions.includes(call.action)) {
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
      const live = repo.liveOfDispatch(dispatchId);
      for (const e of live) end(e);
      return live.length;
    },

    revokeId: (id, actor) => {
      const e = liveById(id);
      if (!e || e.actor !== actor) return false;
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
