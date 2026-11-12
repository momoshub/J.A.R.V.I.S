/**
 * Worker tickets: what an Orca worker may do as the GitHub App, and for how long.
 *
 * A turn ticket (`commandTickets`) lives 20 minutes and carries its caller's
 * whole role, which is right for a turn and useless for an Orca worker that
 * outlives it. A worker ticket is the narrow version: one repo, an explicit
 * allow-list of app actions, bound to one dispatch. Pure rules only; the store
 * is `application/workerTickets.ts`.
 */
import type { ActionName } from "./githubAppAction.ts";

/** Every worker token starts with this, so a redeem can tell it from a turn ticket without a lookup. */
export const WORKER_TOKEN_PREFIX = "jvwk_";
export const isWorkerToken = (v: string): boolean => v.startsWith(WORKER_TOKEN_PREFIX);

export const HOUR_MS = 60 * 60_000;
export const WORKER_TTL_DEFAULT_MS = 3 * HOUR_MS;
/** The most ONE grant or renewal may add: a longer `--ttl` is clamped to it and says so. */
export const WORKER_TTL_MAX_MS = 6 * HOUR_MS;
/**
 * Absolute lifetime, counted from the bind: renewals (by an admin or by the
 * worker itself) stop here, so no ticket lives forever however often it is renewed.
 */
export const WORKER_LIFETIME_MAX_MS = 24 * HOUR_MS;
/** The action a worker calls on `bin/github-app.sh` to extend its own live ticket (`ticket-renew`). */
export const RENEW_ACTION = "ticket-renew";
/** A minted ticket not yet bound to a dispatch: the gap between `worker-ticket` and `worker-start`. */
export const PENDING_TTL_MS = 10 * 60_000;

/**
 * What a worker gets when the brain names no actions: open the PR, talk on it,
 * edit it. Not `git-auth` (git and push): a worker pushes with the one-shot
 * human credential of the org's own rule (where the app has contents:read it
 * cannot push anyway). `git`/`push` stay an explicit opt-in.
 */
export const DEFAULT_WORKER_ACTIONS: readonly ActionName[] = ["pr-create", "comment", "pr-edit"];
/**
 * The most a worker ticket can ever grant. No review (a worker approving its own
 * PR), no merge, no close/reopen, no label removal: those stay with a turn.
 */
export const WORKER_ACTION_CEILING: readonly ActionName[] = [...DEFAULT_WORKER_ACTIONS, "git-auth", "labels-add", "reviewers-request"];

/** The brain says `git` / `push`; on the wire both are the `git-auth` action. */
const ALIASES: Readonly<Record<string, ActionName>> = { git: "git-auth", push: "git-auth" };

export type WorkerTicketRequest = {
  repo: string;
  /** `pending` = bind later with `worker-ticket bind`. */
  dispatchId: string | "pending";
  actions: readonly ActionName[];
  ttlMs: number;
};

const REPO = /^[\w.-]+\/[\w.-]+$/;
const DISPATCH = /^ctx_[A-Za-z0-9_-]+$/;

/** `3h`, `90m`, `45` (minutes). Undefined when it is not a duration. */
export const parseTtl = (v: string): number | undefined => {
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|h|hr)?$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  const ms = Math.round(n * (unit.startsWith("h") ? HOUR_MS : 60_000));
  return ms > 0 ? ms : undefined;
};

/** The repo as the store compares it: GitHub names are case-insensitive. */
export const normRepo = (repo: string): string => repo.trim().toLowerCase();

/**
 * `<owner/repo> <dispatchId|pending> [actions...] [--ttl 3h]`. The TTL is
 * clamped to `WORKER_TTL_MAX_MS` rather than refused, and says so; an action
 * outside the ceiling is refused, never dropped.
 */
export const parseWorkerTicketArgs = (
  args: readonly string[],
): { ok: true; req: WorkerTicketRequest; clamped: boolean } | { ok: false; error: string } => {
  const words: string[] = [];
  let ttl: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--ttl") ttl = args[++i] ?? "";
    else if (a.startsWith("--ttl=")) ttl = a.slice("--ttl=".length);
    else words.push(a);
  }
  const [repo = "", dispatch = "", ...rest] = words;
  if (!REPO.test(repo)) return { ok: false, error: "the first argument must be owner/repo" };
  if (dispatch !== "pending" && !DISPATCH.test(dispatch)) {
    return { ok: false, error: "the second argument must be a ctx_... dispatch id, or `pending` to bind it after worker-start" };
  }
  const actions: ActionName[] = [];
  for (const raw of rest) {
    const name = ALIASES[raw] ?? raw;
    if (!(WORKER_ACTION_CEILING as readonly string[]).includes(name)) {
      return { ok: false, error: `a worker may not get \`${raw}\`; the most a worker ticket grants is ${WORKER_ACTION_CEILING.join(", ")}` };
    }
    if (!actions.includes(name as ActionName)) actions.push(name as ActionName);
  }
  let ttlMs = WORKER_TTL_DEFAULT_MS;
  if (ttl !== undefined) {
    const parsed = parseTtl(ttl);
    if (parsed === undefined) return { ok: false, error: "--ttl wants a duration like 3h or 90m" };
    ttlMs = parsed;
  }
  const clamped = ttlMs > WORKER_TTL_MAX_MS;
  return {
    ok: true,
    clamped,
    req: {
      repo: normRepo(repo),
      dispatchId: dispatch,
      actions: actions.length > 0 ? actions : DEFAULT_WORKER_ACTIONS,
      ttlMs: Math.min(ttlMs, WORKER_TTL_MAX_MS),
    },
  };
};

/** The dispatch a `watch worker` line says is over (finished or died, not merely waiting). */
export const endedWorkerOf = (output: string): string | undefined =>
  output.match(/^orca worker (ctx_[A-Za-z0-9_-]+) (?:finished|died):/m)?.[1];

/**
 * `renew <id|ctx_...> [--ttl 3h]`, the words after `worker-ticket`. The TTL
 * defaults to `WORKER_TTL_DEFAULT_MS`; clamping to `WORKER_TTL_MAX_MS` is the
 * store's job (it reports it), so a worker's own `ttl` field goes the same way.
 */
export const parseRenewArgs = (
  args: readonly string[],
): { ok: true; target: string; ttlMs: number } | { ok: false; error: string } => {
  const words: string[] = [];
  let ttl: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--ttl") ttl = args[++i] ?? "";
    else if (a.startsWith("--ttl=")) ttl = a.slice("--ttl=".length);
    else words.push(a);
  }
  const [target = "", ...extra] = words;
  if (!target || extra.length > 0 || !(DISPATCH.test(target) || /^[0-9a-f]{8}$/.test(target))) {
    return { ok: false, error: "name one ticket by its 8-hex id or by its ctx_... dispatch id" };
  }
  if (ttl === undefined) return { ok: true, target, ttlMs: WORKER_TTL_DEFAULT_MS };
  const parsed = parseTtl(ttl);
  return parsed === undefined ? { ok: false, error: "--ttl wants a duration like 3h or 90m" } : { ok: true, target, ttlMs: parsed };
};
