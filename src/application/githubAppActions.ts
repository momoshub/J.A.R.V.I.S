/**
 * Acting on GitHub as the app, for a turn.
 *
 * The turn never names who it is: its ticket does, and the ticket resolves to
 * the Slack user the turn runs as. Only an executer, an admin or the owner may use the
 * app's identity, every attempt (allowed or refused) is written to the command
 * log, and the app's private key stays in the bot - a turn gets GitHub's JSON
 * back and nothing else. The installation is looked up for the target repo's
 * own owner, so an app installed on several orgs reaches each of them; GitHub's
 * refusal (not installed, missing permission) is returned as it came.
 */
import { type ActionRequest, DENIED_MESSAGE, mayActAsApp, planAction, summarize } from "../domain/githubAppAction.ts";
import { isAllowedOwner } from "../domain/githubApp.ts";
import type { AllowedUser } from "../domain/types.ts";
import type { CommandLogRepo } from "../infrastructure/db/commandLogRepo.ts";
import { isWorkerToken, parseTtl, RENEW_ACTION, WORKER_TTL_DEFAULT_MS } from "../domain/workerTicket.ts";
import { logAndIgnore } from "./ignoredError.ts";
import type { Clock } from "./ports.ts";
import { type WorkerRedeem, type WorkerRenewal, renewalSummary } from "./workerTickets.ts";

export type GithubActionDeps = {
  clock: Clock;
  /** Resolve a turn's ticket to who it runs as; throws with a plain message if it will not. */
  resolve: (ticket: string) => { actor: string; channel: string; threadTs?: string };
  /**
   * Resolve a worker ticket (`jvwk_...`, see `workerTickets.ts`) for ONE call:
   * it checks the action and the repo against what the ticket grants. Absent
   * means worker tickets are not accepted here.
   */
  resolveWorker?: (token: string, call: { action: string; repo: string }) => WorkerRedeem;
  /** A worker extends its own live ticket (`ticket-renew`, see `workerTickets.renewSelf`). Absent means it cannot. */
  renewWorker?: (token: string, ttlMs: number) => WorkerRenewal;
  users: { get: (slackId: string) => AllowedUser | undefined };
  github: {
    installationOfRepo: (repo: string) => Promise<number>;
    installationToken: (installationId: number) => Promise<string>;
    /**
     * A token for one worker ticket: uncached, limited to the repo and to what
     * git needs (see `appClient.mintWorkerToken`).
     */
    mintWorkerToken: (installationId: number, repo: string) => Promise<{ token: string; expiresAt: number }>;
    /** Make GitHub stop honouring a token now (`DELETE /installation/token`). */
    revokeInstallationToken: (token: string) => Promise<void>;
    request: (installationId: number, method: string, path: string, body?: unknown) => Promise<unknown>;
  };
  audit: Pick<CommandLogRepo, "add">;
  /**
   * A PR was opened from a Slack thread (a turn's, or its worker's): remember
   * which, so the stuck-work report can link the thread whoever ran the command.
   */
  onPrCreated?: (pr: { url: string; channelId: string; threadTs: string }) => void;
  /**
   * Owners the app may act on (`GITHUB_APP_ALLOWED_OWNERS`). The app is public,
   * so anybody can install it; acting as it is limited to the same owners the
   * webhook listens to.
   */
  allowedOwners: readonly string[];
  /** The app's slug (`GITHUB_APP_SLUG`); its commit identity is `<slug>[bot]`. */
  slug: string;
};

export type GithubActionResult = { url?: string; number?: number; github: unknown };

/** What a local `git` needs to act as the app on one repo (action `git-auth`). */
export type GitAuth = { token: string; name: string; email: string };

export type GithubActions = {
  run: (req: { ticket: string } & ActionRequest) => Promise<GithubActionResult>;
  /**
   * A worker ticket ended (revoked or expired): revoke, at GitHub, the token
   * minted for it. Resolves when GitHub has answered; a failure is thrown so the
   * caller can log it.
   */
  endWorker: (ticketId: string) => Promise<void>;
};

/** Reuse a worker's held token until this close to its expiry. */
const WORKER_TOKEN_MARGIN_MS = 5 * 60_000;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The audit line: what was asked, never the body text. */
const list = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(",").slice(0, 120) : "");
const describe = (req: ActionRequest): string =>
  [
    req.repo,
    req.number,
    req.head && `head=${String(req.head)}`,
    req.base && `base=${String(req.base)}`,
    req.event,
    req.method,
    typeof req.ttl === "string" && req.ttl && `ttl=${req.ttl.slice(0, 12)}`,
    req.action === "pr-create" && `draft=${req.draft === true}`,
    typeof req.title === "string" && req.title && `title=${req.title.length}ch`,
    req.body !== undefined && req.action === "pr-edit" && "body=changed",
    list(req.labels) && `labels=${list(req.labels)}`,
    list(req.reviewers) && `reviewers=${list(req.reviewers)}`,
  ]
    .filter((x) => x !== undefined && x !== "" && x !== null && x !== false)
    .join(" ");

export const createGithubActions = (deps: GithubActionDeps): GithubActions => {
  // The bot's numeric user id never changes, so look it up once per slug.
  let botId: number | undefined;
  const botName = `${deps.slug}[bot]`;
  const botIdentity = async (installation: number): Promise<{ name: string; email: string }> => {
    if (botId === undefined) {
      const out = (await deps.github.request(installation, "GET", `users/${encodeURIComponent(botName)}`)) as
        | { id?: unknown }
        | undefined;
      if (typeof out?.id !== "number") throw new Error(`GitHub returned no user id for ${botName}`);
      botId = out.id;
    }
    return { name: botName, email: `${botId}+${botName}@users.noreply.github.com` };
  };
  const gitAuth = async (installation: number): Promise<GitAuth> => ({
    token: await deps.github.installationToken(installation),
    ...(await botIdentity(installation)),
  });
  // One GitHub token per worker ticket, held in memory only, reused until near its
  // expiry and revoked when the ticket ends. Never shared between tickets and
  // never written down: a restart loses the handle (see `endWorker`).
  const held = new Map<string, Promise<{ token: string; expiresAt: number }>>();
  const workerGitAuth = async (installation: number, repo: string, ticketId: string): Promise<GitAuth> => {
    const identity = await botIdentity(installation);
    const current = held.get(ticketId);
    if (current) {
      const t = await current.catch(() => undefined);
      if (t && t.expiresAt - WORKER_TOKEN_MARGIN_MS > deps.clock()) return { token: t.token, ...identity };
      held.delete(ticketId);
      if (t) await deps.github.revokeInstallationToken(t.token).catch(logAndIgnore("worker token rotate"));
    }
    const minted = deps.github.mintWorkerToken(installation, repo);
    held.set(ticketId, minted);
    try {
      return { token: (await minted).token, ...identity };
    } catch (e) {
      held.delete(ticketId);
      throw e;
    }
  };

  return {
    endWorker: async (ticketId) => {
      const p = held.get(ticketId);
      held.delete(ticketId);
      const t = await p?.catch(() => undefined);
      if (t) await deps.github.revokeInstallationToken(t.token);
    },
    run: async ({ ticket, ...req }) => {
      if (!ticket.trim()) throw new Error("no ticket - acting as the app only works from inside a turn");
      // A worker ticket is checked against what will RUN (the plan's action and
      // repo, not the raw request), and every outcome is audited with its
      // dispatch and a short id, never the token.
      const plan = planAction(req);
      const asWorker = isWorkerToken(ticket);
      const call = plan.ok ? { action: plan.action, repo: plan.repo } : { action: String(req.action), repo: String(req.repo) };
      const worker = asWorker
        ? (deps.resolveWorker?.(ticket, call) ?? {
            ok: false as const,
            reason: "unknown" as const,
            message: "worker tickets are not accepted here",
          })
        : undefined;
      const ctx = worker?.ok ? worker : worker ? { actor: worker.actor ?? "worker-ticket", channel: worker.channel ?? "" } : deps.resolve(ticket);
      const tag = worker ? ` worker=${worker.dispatchId ?? "unbound"} t=${worker.id ?? "?"}` : "";
      const user = deps.users.get(ctx.actor);
      const log = (ok: boolean, result: string): void =>
        deps.audit.add(
          {
            slackUserId: ctx.actor,
            command: "github-app",
            args: `${String(req.action)} ${describe(req)}${tag}`.trim(),
            channelId: ctx.channel,
            ok,
            result: result.slice(0, 300),
          },
          deps.clock(),
        );
      const refuse = (message: string): never => {
        log(false, message);
        throw new Error(message);
      };

      if (worker && !worker.ok) refuse(worker.message);
      if (!user) refuse("whoever asked is not on the access list");
      if (user && !mayActAsApp(user.role)) refuse(DENIED_MESSAGE);
      if (!plan.ok) return refuse(plan.error);
      const owner = plan.repo.split("/")[0] ?? "";
      if (!isAllowedOwner(owner, deps.allowedOwners)) {
        return refuse(`${owner} is not in GITHUB_APP_ALLOWED_OWNERS, so the app will not act there`);
      }

      if (plan.action === RENEW_ACTION) {
        // Not a GitHub call: the worker extends its own ticket. Only a worker ticket has one, and
        // `resolveWorker` already refused it if it is not live, bound, or for this repo.
        if (!worker?.ok || !deps.renewWorker) return refuse("only a worker can renew its own ticket, and only with its worker ticket");
        const asked = typeof req.ttl === "string" && req.ttl.trim() ? parseTtl(req.ttl) : WORKER_TTL_DEFAULT_MS;
        if (asked === undefined) return refuse("ttl wants a duration like 3h or 90m");
        const renewed = deps.renewWorker(ticket, asked);
        if (!renewed.ok) return refuse(renewed.error);
        const summary = renewalSummary(renewed, deps.clock());
        log(true, summary);
        return { github: { renewed: { id: renewed.id, expiresAt: renewed.expiresAt, ttlMs: renewed.ttlMs, clamped: renewed.clamped, capped: renewed.capped, message: summary } } };
      }

      try {
        const installation = await deps.github.installationOfRepo(plan.repo);
        if (plan.action === "git-auth") {
          // The token goes back to the helper only; the audit row never has it.
          // A worker's token is its own: one repo, git's permissions only, revoked with the ticket.
          const auth = worker?.ok ? await workerGitAuth(installation, plan.repo, worker.id) : await gitAuth(installation);
          log(true, `git-auth ${plan.repo}`);
          return { github: auth };
        }
        const outs: unknown[] = [];
        for (const c of plan.calls) outs.push(await deps.github.request(installation, c.method, c.path, c.body));
        const out = outs.length === 1 ? outs[0] : outs;
        const summary = summarize(out);
        log(true, summary.url ?? `${plan.action} ok`);
        const threadTs = worker?.ok ? worker.threadTs : "threadTs" in ctx ? ctx.threadTs : undefined;
        if (plan.action === "pr-create" && summary.url && threadTs && ctx.channel) {
          try {
            deps.onPrCreated?.({ url: summary.url, channelId: ctx.channel, threadTs });
          } catch (e) {
            logAndIgnore("record PR thread")(e);
          }
        }
        return { ...summary, github: out ?? null };
      } catch (e) {
        log(false, errText(e));
        throw e;
      }
    },
  };
};
