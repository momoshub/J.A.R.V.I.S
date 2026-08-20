/**
 * GitHub adapter - wraps the local `gh` binary.
 *
 * Only the actions the bot performs itself live here (the brain still runs its
 * own `gh` calls through the CLI's Bash tool for everything judgement-based).
 * Failures are returned, never thrown: a refused approval is something to report
 * in the thread, not a reason to abandon the review.
 */
import type { ApproveResult, GitHubPort } from "../../application/github.ts";

export type GhCliConfig = {
  /** Path or name of the gh binary. Default "gh". */
  binPath?: string;
  /** Hard timeout for a single invocation, ms. Default 30000. */
  timeoutMs?: number;
};

/** Trim gh's chatter down to something worth putting in a Slack line. */
const firstLine = (s: string): string => s.trim().split("\n").find((l) => l.trim())?.trim() ?? "";

export const createGhCli = (config: GhCliConfig = {}): GitHubPort => {
  const run = async (args: readonly string[]): Promise<{ code: number; out: string; err: string }> => {
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
    return { code, out, err };
  };

  return {
    approve: async (prUrl: string): Promise<ApproveResult> => {
      try {
        const { code, out, err } = await run(["pr", "review", prUrl, "--approve"]);
        if (code === 0) return { ok: true };
        return { ok: false, error: firstLine(err) || firstLine(out) || `gh exited with code ${code}` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
};
