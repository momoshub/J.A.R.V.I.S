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
  /** Model for this call, overriding the adapter default. */
  model?: string;
};

/**
 * Read-only default allow-list: context tools, safe read commands, the web, and
 * read-only MCP connectors.
 *
 * MCP names depend on what the CLI's own config exposes; entries for servers
 * that are not connected are simply inert, so listing them costs nothing.
 */
export const PAL_TOOLS: readonly string[] = [
  "Read", "Grep", "Glob", "LS", "TodoWrite",
  // the web
  "WebSearch", "WebFetch",
  // github, read only
  "Bash(gh pr view:*)", "Bash(gh pr diff:*)", "Bash(gh pr checks:*)", "Bash(gh pr list:*)",
  "Bash(gh issue view:*)", "Bash(gh issue list:*)",
  "Bash(gh repo view:*)", "Bash(gh release view:*)", "Bash(gh release list:*)",
  "Bash(gh run view:*)", "Bash(gh run list:*)", "Bash(gh workflow list:*)",
  "Bash(gh search:*)", "Bash(gh api:*)",
  "mcp__claude_ai_Github_MCP", "mcp__github",
  // notion, read only
  "mcp__claude_ai_Notion__notion-search", "mcp__claude_ai_Notion__notion-fetch",
  "mcp__claude_ai_Notion__notion-get-comments", "mcp__claude_ai_Notion__notion-get-users",
  "mcp__claude_ai_Notion__notion-query-data-sources",
  "mcp__claude_ai_Notion__notion-list-recent-pages", "mcp__claude_ai_Notion__notion-list-shared-pages",
  "mcp__notion__notion-search", "mcp__notion__notion-fetch",
  // git, read only
  "Bash(git log:*)", "Bash(git show:*)", "Bash(git diff:*)", "Bash(git status:*)",
  "Bash(git branch:*)", "Bash(git blame:*)", "Bash(git grep:*)",
  "Bash(aws:*)",
  // grafana, read only. `gcx logs adaptive` and `gcx dev` write, so the query
  // subcommands are listed one by one rather than the whole `gcx logs` family.
  "Bash(gcx logs query:*)", "Bash(gcx logs labels:*)", "Bash(gcx logs series:*)",
  "Bash(gcx logs metrics:*)", "Bash(gcx metrics query:*)", "Bash(gcx traces query:*)",
  "Bash(gcx datasources list:*)", "Bash(gcx dashboards list:*)", "Bash(gcx agent skills:*)",
];

/**
 * Denied to EVERY role, full access included.
 *
 * `--disallowedTools` is honoured alongside `--dangerously-skip-permissions`, so
 * these are real denials rather than requests.
 *
 * - WRITING through a Slack connector posts as whichever human authorised it,
 *   so the bot's reply arrives under someone else's name. It has its own token
 *   and must use it for everything it says. Reading is a different matter and
 *   is allowed: it impersonates nobody, and it is the only way to see a channel
 *   or group DM the bot has not been invited to. The deny-list is therefore the
 *   write tools by name rather than the whole connector - a blanket ban also
 *   refused the reads, which was never the point.
 * - CloudWatch bills per GB scanned, and the logs live in Grafana anyway.
 */
export const SLACK_CONNECTOR_WRITES: readonly string[] = [
  "mcp__claude_ai_Slack__slack_send_message",
  "mcp__claude_ai_Slack__slack_send_message_draft",
  "mcp__claude_ai_Slack__slack_schedule_message",
  "mcp__claude_ai_Slack__slack_create_canvas",
  "mcp__claude_ai_Slack__slack_update_canvas",
  "mcp__slack__slack_send_message",
  "mcp__slack__slack_post_message",
];

export const ALWAYS_DISALLOW: readonly string[] = [
  ...SLACK_CONNECTOR_WRITES,
  "Bash(aws logs:*)",
  "Bash(aws cloudwatch:*)",
];

/** Additionally denied to sandboxed roles: writes and secret reads. */
export const SANDBOX_DISALLOW: readonly string[] = [
  ...ALWAYS_DISALLOW,
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
  /**
   * Absolute path of the reaction helper. Sandboxed roles get exactly this
   * script rather than a general `curl`, so the bot can react in every
   * conversation without handing anyone an outbound request with its token.
   */
  readonly reactScript?: string;
  /**
   * Absolute path of the command helper. Granted to every role: what it can
   * actually run is decided by the caller's own role when the command
   * dispatches, so this hands over no authority of its own.
   */
  readonly runScript?: string;
  /** Absolute path of the Slack file downloader. Reading what people share is
   * table stakes, so every role gets it - it can only reach files.slack.com. */
  readonly fileScript?: string;
  /**
   * Absolute path of the read-only Grafana helper. Granted to every role: `gcx
   * api` can write, this cannot, so it is the only way a sandboxed role reaches
   * a datasource that `gcx logs` refuses.
   */
  readonly grafanaGetScript?: string;
  /**
   * Absolute path of the Slack reader. Sandboxed roles have no `curl` - a
   * general outbound request with the bot token in the environment is an
   * exfiltration channel - but the bot can genuinely read these conversations,
   * and refusing is a worse answer than a narrow door.
   */
  readonly slackReadScript?: string;
  /**
   * Model per role, for roles that should not be spending the expensive one on
   * ordinary chat. Absent means the adapter's default.
   */
  readonly models?: Partial<Record<UserRole, string>>;
  /**
   * Model pinned to the conversation this call is happening in. Outranks the
   * role's model: a channel is a room with a purpose, and whoever set it up
   * knows what the work there is worth.
   */
  readonly channelModel?: string;
};

/**
 * Helpers every role gets on top of its list: reacting, and asking the bot to
 * run one of its own commands. Neither grants authority - the command's role
 * gate still decides - so they sit outside the assigned tools.
 */
const withHelpers = (tools: readonly string[], opts: ToolPolicyOptions): readonly string[] => [
  ...tools,
  ...(opts.reactScript ? [`Bash(${opts.reactScript}:*)`] : []),
  ...(opts.runScript ? [`Bash(${opts.runScript}:*)`] : []),
  ...(opts.fileScript ? [`Bash(${opts.fileScript}:*)`] : []),
  ...(opts.grafanaGetScript ? [`Bash(${opts.grafanaGetScript}:*)`] : []),
  ...(opts.slackReadScript ? [`Bash(${opts.slackReadScript}:*)`] : []),
];

/** Channel beats role beats the adapter default. */
const modelOf = (role: UserRole, opts: ToolPolicyOptions): string | undefined =>
  opts.channelModel?.trim() || opts.models?.[role];

export const toolPolicyFor = (role: UserRole, opts: ToolPolicyOptions): ToolPolicy => {
  switch (role) {
    case "owner":
    case "admin":
      return {
        skipPermissions: true,
        cwd: opts.fullCwd,
        model: modelOf(role, opts),
        // Full access still does not mean "post as a human" or "bill us per query".
        disallowedTools: ALWAYS_DISALLOW,
      };
    case "executer":
      return {
        skipPermissions: false,
        cwd: opts.sandboxCwd,
        allowedTools: withHelpers(
          opts.executerTools && opts.executerTools.length > 0 ? opts.executerTools : PAL_TOOLS,
          opts,
        ),
        disallowedTools: SANDBOX_DISALLOW,
        model: modelOf("executer", opts),
      };
    case "pal":
    default:
      return {
        skipPermissions: false,
        cwd: opts.sandboxCwd,
        allowedTools: withHelpers(PAL_TOOLS, opts),
        disallowedTools: SANDBOX_DISALLOW,
        model: modelOf("pal", opts),
      };
  }
};
