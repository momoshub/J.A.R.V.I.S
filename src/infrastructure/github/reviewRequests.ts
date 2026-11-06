/**
 * Review requests of the `gh` account, read with the `gh` binary.
 *
 * Search finds the open PRs still waiting on the account (`user-review-requested`
 * leaves team requests out), and each PR's timeline says who asked and when -
 * the latest request, so a re-request after a push counts as a new one.
 */
import type { ReviewRequest } from "../../domain/reviewInbox.ts";

export type GhReviewRequestsConfig = { binPath?: string; timeoutMs?: number };

export type GhReviewRequests = {
  /** Only PRs touched at or after `since` (ISO) - a request touches its PR. */
  requests: (since?: string) => Promise<ReviewRequest[]>;
  githubName: (login: string) => Promise<string | undefined>;
};

type SearchItem = { updated_at?: unknown; html_url?: unknown; title?: unknown; number?: unknown; repository_url?: unknown };
type TimelineEvent = {
  event?: unknown;
  created_at?: unknown;
  actor?: { login?: unknown };
  requested_reviewer?: { login?: unknown };
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** The latest request of `me` in a timeline, or undefined. */
export const latestRequestOf = (
  events: readonly TimelineEvent[],
  me: string,
): { requester: string; requestedAt: string } | undefined => {
  let found: { requester: string; requestedAt: string } | undefined;
  for (const e of events) {
    if (e.event !== "review_requested") continue;
    if (str(e.requested_reviewer?.login)?.toLowerCase() !== me.toLowerCase()) continue;
    const requester = str(e.actor?.login);
    const requestedAt = str(e.created_at);
    if (requester && requestedAt) found = { requester, requestedAt };
  }
  return found;
};

export const createGhReviewRequests = (config: GhReviewRequestsConfig = {}): GhReviewRequests => {
  const gh = async (args: readonly string[]): Promise<unknown> => {
    const proc = Bun.spawn({
      cmd: [config.binPath ?? "gh", ...args],
      stdout: "pipe",
      stderr: "pipe",
      timeout: config.timeoutMs ?? 30_000,
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`gh ${args[1] ?? ""} failed: ${err.trim().split("\n")[0] ?? code}`);
    return JSON.parse(out) as unknown;
  };

  let me: Promise<string> | undefined;
  const login = (): Promise<string> =>
    (me ??= gh(["api", "user"]).then((u) => {
      const l = str((u as { login?: unknown }).login);
      if (!l) throw new Error("gh has no login");
      return l;
    })).catch((e: unknown) => {
      me = undefined;
      throw e;
    });

  return {
    requests: async (since) => {
      const account = await login();
      const found = (await gh([
        "api",
        "-X",
        "GET",
        "search/issues",
        "-f",
        "q=is:pr is:open archived:false user-review-requested:@me",
        "-f",
        "per_page=100",
      ])) as { items?: SearchItem[] };
      const out: ReviewRequest[] = [];
      for (const item of found.items ?? []) {
        const prUrl = str(item.html_url);
        const repo = str(item.repository_url)?.replace(/^https:\/\/api\.github\.com\/repos\//, "");
        const number = typeof item.number === "number" ? item.number : undefined;
        if (!prUrl || !repo || number === undefined) continue;
        const updated = Date.parse(str(item.updated_at) ?? "");
        if (since && Number.isFinite(updated) && updated < Date.parse(since)) continue;
        const pages = (await gh(["api", "--paginate", "--slurp", `repos/${repo}/issues/${number}/timeline?per_page=100`])) as TimelineEvent[][];
        const req = latestRequestOf(pages.flat(), account);
        if (req) out.push({ prUrl, repo, number, title: str(item.title) ?? "", ...req });
      }
      return out;
    },
    githubName: async (l) => {
      try {
        return str(((await gh(["api", `users/${l}`])) as { name?: unknown }).name);
      } catch {
        return undefined;
      }
    },
  };
};
