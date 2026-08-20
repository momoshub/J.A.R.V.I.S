/**
 * Per-role tool policy for the Claude CLI brain.
 *
 * - owner / admin: full access (skip permissions, any tool, the normal cwd)
 * - pal: sandboxed read-only tools in a fixed scratch dir (may still use `review`)
 * - executer: sandboxed, tools assigned from the control deck
 *
 * When `skipPermissions` is false the CLI runs with an `--allowedTools` allow-list
 * and no permission bypass, so anything off the list is denied.
 */
import type { UserRole } from "./types.ts";

export type ToolPolicy = {
  skipPermissions: boolean;
  cwd?: string;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  /** Per-call timeout override (ms) - e.g. long-running PR reviews. */
  timeoutMs?: number;
};

/** Read-only default allow-list: context tools + safe read commands + web. */
export const PAL_TOOLS: readonly string[] = [
  "Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch", "TodoWrite",
  "Bash(gh pr view:*)", "Bash(gh pr diff:*)", "Bash(gh pr checks:*)", "Bash(gh pr list:*)",
  "Bash(gh search:*)", "Bash(gh api:*)",
  "Bash(git log:*)", "Bash(git show:*)", "Bash(git diff:*)", "Bash(git status:*)",
  "Bash(git branch:*)", "Bash(git blame:*)", "Bash(git grep:*)",
  "Bash(aws:*)",
];

/** Never allowed for sandboxed roles: writes and secret reads. */
export const SANDBOX_DISALLOW: readonly string[] = [
  "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Bash(aws secretsmanager:*)", "Bash(aws ssm get-parameter:*)", "Bash(aws kms:*)",
];

export type ToolPolicyOptions = {
  /** cwd for full-access roles (owner/admin). */
  readonly fullCwd?: string;
  /** fixed scratch dir for sandboxed roles (pal/executer). */
  readonly sandboxCwd?: string;
  /** tool allow-list for the executer role, assigned from the control deck. */
  readonly executerTools?: readonly string[];
};

export const toolPolicyFor = (role: UserRole, opts: ToolPolicyOptions): ToolPolicy => {
  switch (role) {
    case "owner":
    case "admin":
      return { skipPermissions: true, cwd: opts.fullCwd };
    case "executer":
      return {
        skipPermissions: false,
        cwd: opts.sandboxCwd,
        allowedTools: opts.executerTools && opts.executerTools.length > 0 ? opts.executerTools : PAL_TOOLS,
        disallowedTools: SANDBOX_DISALLOW,
      };
    case "pal":
    default:
      return {
        skipPermissions: false,
        cwd: opts.sandboxCwd,
        allowedTools: PAL_TOOLS,
        disallowedTools: SANDBOX_DISALLOW,
      };
  }
};
