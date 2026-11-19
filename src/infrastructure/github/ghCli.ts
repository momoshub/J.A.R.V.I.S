/**
 * GitHub adapter - wraps the local `gh` binary.
 *
 * Only the actions the bot performs itself live here (the brain still runs its
 * own `gh` calls through the CLI's Bash tool for everything judgement-based).
 * Failures are returned, never thrown: a refused approval is something to report
 * in the thread, not a reason to abandon the review.
 */
import type { ApproveResult, GitHubPort, PrSnapshot, Reviewer } from "../../application/github.ts";
import { asPrState, ciStatusOf, type RollupEntry } from "../../domain/ciGate.ts";
import { parsePrUrl, sameLogin } from "../../domain/reviewIdentity.ts";

export type GhCliConfig = {
  /** Path or name of the gh binary. Default "gh". */
  binPath?: string;
  /** Hard timeout for a single invocation, ms. Default 30000. */
  timeoutMs?: number;
  /**
   * A token to act with on one repository (`owner/repo`), instead of the login
   * `gh` holds - how the same adapter acts as the GitHub App. Absent or
   * resolving to nothing: `gh` uses its own account.
   */
  tokenFor?: (repo: string) => Promise<string | undefined>;
  /**
   * The account this adapter acts as, when it cannot be asked (an installation
   * token has no `/user`). Absent: asked of GitHub once.
   */
  account?: Reviewer;
};

/** Trim gh's chatter down to something worth putting in a Slack line. */
const firstLine = (s: string): string => s.trim().split("\n").find((l) => l.trim())?.trim() ?? "";

export const createGhCli = (config: GhCliConfig = {}): GitHubPort => {
  const run = async (args: readonly string[], prUrl?: string): Promise<{ code: number; out: string; err: string }> => {
    // A token for this PR's repo replaces gh's own login for this one call.
    const repo = prUrl ? parsePrUrl(prUrl)?.repo : undefined;
    const token = repo && config.tokenFor ? await config.tokenFor(repo) : undefined;
    const proc = Bun.spawn({
      cmd: [config.binPath ?? "gh", ...args],
      stdout: "pipe",
      stderr: "pipe",
      timeout: config.timeoutMs ?? 30_000,
      ...(token ? { env: { ...process.env, GH_TOKEN: token } } : {}),
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err };
  };

  // Resolved once per process: the account cannot change under us, and the review
  // command needs it on the hot path (it goes into the prompt).
  let account: Promise<Reviewer | undefined> | undefined;
  const resolveAccount = async (): Promise<Reviewer | undefined> => {
    if (config.account) return config.account;
    try {
      const { code, out } = await run(["api", "user"]);
      if (code !== 0) return undefined;
      const parsed: unknown = JSON.parse(out);
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const { login, name } = parsed as { login?: unknown; name?: unknown };
      if (typeof login !== "string" || !login) return undefined;
      return { login, name: typeof name === "string" && name ? name : undefined };
    } catch {
      return undefined;
    }
  };

  /** `gh pr view --json state,statusCheckRollup,reviewDecision,latestReviews`, read into a snapshot. */
  const snapshotOf = async (prUrl: string): Promise<PrSnapshot | undefined> => {
    try {
      const { code, out } = await run(["pr", "view", prUrl, "--json", "state,statusCheckRollup,reviewDecision,latestReviews"], prUrl);
      if (code !== 0) return undefined;
      const parsed: unknown = JSON.parse(out);
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const { state, statusCheckRollup, reviewDecision, latestReviews } = parsed as {
        state?: unknown;
        statusCheckRollup?: unknown;
        reviewDecision?: unknown;
        latestReviews?: unknown;
      };
      const prState = asPrState(state);
      if (!prState) return undefined;
      const me = (await (account ??= resolveAccount()))?.login;
      const mine = me
        ? (Array.isArray(latestReviews) ? (latestReviews as { author?: { login?: unknown }; state?: unknown }[]) : [])
            .filter((r) => typeof r.author?.login === "string" && sameLogin(r.author.login, me))
            .map((r) => (typeof r.state === "string" ? r.state.toUpperCase() : undefined))
            .find((s) => s !== undefined)
        : undefined;
      return {
        state: prState,
        ci: ciStatusOf(Array.isArray(statusCheckRollup) ? (statusCheckRollup as RollupEntry[]) : []),
        decision: typeof reviewDecision === "string" && reviewDecision ? reviewDecision.toUpperCase() : undefined,
        mine,
      };
    } catch {
      return undefined;
    }
  };

  return {
    snapshot: snapshotOf,

    requestChanges: async (prUrl: string, body: string): Promise<ApproveResult> => {
      try {
        const { code, out, err } = await run(["pr", "review", prUrl, "--request-changes", "--body", body], prUrl);
        if (code === 0) return { ok: true };
        return { ok: false, error: firstLine(err) || firstLine(out) || `gh exited with code ${code}` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    whoami: () => (account ??= resolveAccount()),

    headSha: async (prUrl: string): Promise<string | undefined> => {
      try {
        const { code, out } = await run(["pr", "view", prUrl, "--json", "headRefOid", "--jq", ".headRefOid"], prUrl);
        if (code !== 0) return undefined;
        return /^[0-9a-f]{7,64}$/i.test(out.trim()) ? out.trim().toLowerCase() : undefined;
      } catch {
        return undefined;
      }
    },

    reviewDecision: async (prUrl: string): Promise<string | undefined> => {
      try {
        const { code, out } = await run(["pr", "view", prUrl, "--json", "reviewDecision", "--jq", ".reviewDecision"], prUrl);
        if (code !== 0) return undefined;
        return out.trim() || undefined;
      } catch {
        return undefined;
      }
    },

    author: async (prUrl: string): Promise<string | undefined> => {
      try {
        const { code, out } = await run(["pr", "view", prUrl, "--json", "author", "--jq", ".author.login"], prUrl);
        if (code !== 0) return undefined;
        return out.trim() || undefined;
      } catch {
        return undefined;
      }
    },

    approve: async (prUrl: string): Promise<ApproveResult> => {
      try {
        const { code, out, err } = await run(["pr", "review", prUrl, "--approve"], prUrl);
        if (code === 0) return { ok: true };
        return { ok: false, error: firstLine(err) || firstLine(out) || `gh exited with code ${code}` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
};
