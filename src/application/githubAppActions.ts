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
import type { Clock } from "./ports.ts";

export type GithubActionDeps = {
  clock: Clock;
  /** Resolve a turn's ticket to who it runs as; throws with a plain message if it will not. */
  resolve: (ticket: string) => { actor: string; channel: string };
  users: { get: (slackId: string) => AllowedUser | undefined };
  github: {
    installationOfRepo: (repo: string) => Promise<number>;
    request: (installationId: number, method: string, path: string, body?: unknown) => Promise<unknown>;
  };
  audit: Pick<CommandLogRepo, "add">;
  /**
   * Owners the app may act on (`GITHUB_APP_ALLOWED_OWNERS`). The app is public,
   * so anybody can install it; acting as it is limited to the same owners the
   * webhook listens to.
   */
  allowedOwners: readonly string[];
};

export type GithubActionResult = { url?: string; number?: number; github: unknown };

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

export const createGithubActions = (deps: GithubActionDeps): GithubActions => ({
  run: async ({ ticket, ...req }) => {
    if (!ticket.trim()) throw new Error("no ticket - acting as the app only works from inside a turn");
    const ctx = deps.resolve(ticket);
    const user = deps.users.get(ctx.actor);
    const log = (ok: boolean, result: string): void =>
      deps.audit.add(
        {
          slackUserId: ctx.actor,
          command: "github-app",
          args: `${String(req.action)} ${describe(req)}`.trim(),
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
});
