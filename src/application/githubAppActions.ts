/**
 * Acting on GitHub as the app, for a turn.
 *
 * The turn never names who it is: its ticket does, and the ticket resolves to
 * the Slack user the turn runs as. Only an admin or the owner may use the
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
import { isWorkerToken } from "../domain/workerTicket.ts";
import type { Clock } from "./ports.ts";
import type { WorkerRedeem } from "./workerTickets.ts";

export type GithubActionDeps = {
  clock: Clock;
  /** Resolve a turn's ticket to who it runs as; throws with a plain message if it will not. */
  resolve: (ticket: string) => { actor: string; channel: string };
  /**
   * Resolve a worker ticket (`jvwk_...`, see `workerTickets.ts`) for ONE call:
   * it checks the action and the repo against what the ticket grants. Absent
   * means worker tickets are not accepted here.
   */
  resolveWorker?: (token: string, call: { action: string; repo: string }) => WorkerRedeem;
  users: { get: (slackId: string) => AllowedUser | undefined };
  github: {
    installationOfRepo: (repo: string) => Promise<number>;
    /** `repo` (owner/name) narrows the token to that one repository. */
    installationToken: (installationId: number, repo?: string) => Promise<string>;
    request: (installationId: number, method: string, path: string, body?: unknown) => Promise<unknown>;
  };
  audit: Pick<CommandLogRepo, "add">;
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
};

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
  const gitAuth = async (installation: number, onlyRepo?: string): Promise<GitAuth> => {
    if (botId === undefined) {
      const out = (await deps.github.request(installation, "GET", `users/${encodeURIComponent(botName)}`)) as
        | { id?: unknown }
        | undefined;
      if (typeof out?.id !== "number") throw new Error(`GitHub returned no user id for ${botName}`);
      botId = out.id;
    }
    return { token: await deps.github.installationToken(installation, onlyRepo), name: botName, email: `${botId}+${botName}@users.noreply.github.com` };
  };

  return {
    run: async ({ ticket, ...req }) => {
      if (!ticket.trim()) throw new Error("no ticket - acting as the app only works from inside a turn");
      // A worker ticket is checked against this very call (action + repo) and
      // every outcome is audited with its dispatch and a short id, never the token.
      const asWorker = isWorkerToken(ticket);
      const worker = asWorker
        ? (deps.resolveWorker?.(ticket, { action: String(req.action), repo: String(req.repo) }) ?? {
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
      const plan = planAction(req);
      if (!plan.ok) return refuse(plan.error);
      const owner = plan.repo.split("/")[0] ?? "";
      if (!isAllowedOwner(owner, deps.allowedOwners)) {
        return refuse(`${owner} is not in GITHUB_APP_ALLOWED_OWNERS, so the app will not act there`);
      }

      try {
        const installation = await deps.github.installationOfRepo(plan.repo);
        if (plan.action === "git-auth") {
          // The token goes back to the helper only; the audit row never has it.
          // A worker's token is narrowed to the one repo it was granted.
          const auth = await gitAuth(installation, worker ? plan.repo : undefined);
          log(true, `git-auth ${plan.repo}`);
          return { github: auth };
        }
        const outs: unknown[] = [];
        for (const c of plan.calls) outs.push(await deps.github.request(installation, c.method, c.path, c.body));
        const out = outs.length === 1 ? outs[0] : outs;
        const summary = summarize(out);
        log(true, summary.url ?? `${plan.action} ok`);
        return { ...summary, github: out ?? null };
      } catch (e) {
        log(false, errText(e));
        throw e;
      }
    },
  };
};
