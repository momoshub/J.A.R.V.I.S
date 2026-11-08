/**
 * Per-role tool policy for the Claude CLI brain.
 *
 * - owner / admin: full access (skip permissions, any tool, the normal cwd)
 * - pal: sandboxed read-only tools in a fixed scratch dir (may still use `review`)
 * - executer: sandboxed, tools assigned from the control deck, plus the read-only databases
 *   and the code tools - edit files, commit, push a branch and open a PR - and
 *   the browser tools to test a UI change on the host Mac
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

/**
 * Local database MCP servers configured on the host.
 *
 * These are NOT claude.ai connectors, and the difference matters: a
 * `claude setup-token` credential strips the claude.ai ones (verified - zero
 * `mcp__` tools under one), but a LOCAL stdio server is just a process, and it
 * loads whatever credential the turn holds. Measured after installing these: a
 * setup-token turn ran `select 1` against the production read replica and got
 * its row back. So every turn reaches production SQL unless something refuses
 * it, and an allow-list does not refuse (see NO_TOOLS).
 *
 * They must be named one by one. A bare `mcp__` prefix denies NOTHING -
 * measured with exactly that flag, and the query ran anyway - so a denial has
 * to name the server. Which means this list does not maintain itself: a new
 * database server added to `~/.claude.json` is reachable by every role until
 * its name is added here.
 */
export const DB_MCP_SERVERS: readonly string[] = [
  "mcp__pg-prod",
  "mcp__pg-prod-2",
  "mcp__pg-staging",
  "mcp__clickhouse-sql-us-prod-ro",
  "mcp__clickhouse-sql-sg-prod-ro",
  "mcp__clickhouse-sql-sg-stg-rw",
  "mcp__clickhouse-cloud-mgmt",
];

/**
 * The database servers an executer may query: only those whose credential is
 * read only on the server side (dbhub `readonly = true`, ClickHouse readonly
 * users). `clickhouse-sql-sg-stg-rw` logs in as a write user, and
 * `clickhouse-cloud-mgmt` reaches every service in the org with the host
 * login's key, so both stay denied.
 */
export const EXECUTER_DB_SERVERS: readonly string[] = [
  "mcp__pg-prod",
  "mcp__pg-prod-2",
  "mcp__pg-staging",
  "mcp__clickhouse-sql-us-prod-ro",
  "mcp__clickhouse-sql-sg-prod-ro",
];

/**
 * Tools a side question may use: none.
 *
 * It has to be a DENY list. `--allowedTools` pre-approves what is on it and
 * does NOT restrict what is off it - measured against this CLI with the exact
 * flags a `pal` turn is given: a bare `uname -n` ran, returned the real
 * hostname, and reported no permission denial, despite `Bash` appearing in the
 * allow-list only as specific `Bash(gh ...)` patterns. `--disallowedTools` is
 * the lever that actually refuses (same measurement: zero tool calls, and the
 * model itself says it has no Bash tool).
 *
 * Checking which tools the model SAYS it has is not a test, and neither is
 * reading an answer it could have fabricated - the first version of this
 * measurement asked for a string that was already in the prompt, so the model
 * simply wrote it back and looked like it had run the command. Count the
 * `tool_use` blocks.
 */
export const NO_TOOLS: readonly string[] = [
  "Bash", "Task", "Agent",
  "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead",
  "Glob", "Grep", "LS", "TodoWrite",
  "WebFetch", "WebSearch",
  // A side question running a production query is the opposite of an aside.
  ...DB_MCP_SERVERS,
];

/**
 * Additionally denied to sandboxed roles: writes, secret reads, and the
 * databases.
 *
 * The database servers are here rather than merely absent from `PAL_TOOLS`
 * because absence is not a denial - that is the whole lesson of `NO_TOOLS`.
 * A `pal` is the lowest trust level the bot has and most of the workspace is
 * one; arbitrary SQL against the production replica is not theirs to run, and
 * `investigate` (host login, admin-gated) is the route when it is needed.
 */
export const SANDBOX_DISALLOW: readonly string[] = [
  ...ALWAYS_DISALLOW,
  "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Bash(aws secretsmanager:*)", "Bash(aws ssm get-parameter:*)", "Bash(aws kms:*)",
  ...DB_MCP_SERVERS,
];

/**
 * What an executer needs to change an ordinary codebase: write files in a
 * clone, commit, push a branch and open a PR. Merging is not on it, and a
 * force push is denied below - review stays a human step.
 */
export const EXECUTER_CODE_TOOLS: readonly string[] = [
  "Write", "Edit", "MultiEdit",
  "Bash(mkdir:*)",
  "Bash(gh repo clone:*)", "Bash(gh pr create:*)", "Bash(gh pr edit:*)", "Bash(gh pr comment:*)",
  "Bash(git clone:*)", "Bash(git fetch:*)", "Bash(git pull:*)",
  "Bash(git checkout:*)", "Bash(git switch:*)", "Bash(git restore:*)",
  "Bash(git add:*)", "Bash(git rm:*)", "Bash(git mv:*)", "Bash(git commit:*)", "Bash(git push:*)",
];

/**
 * What an executer needs to test a UI change in Brave on the host Mac and show
 * the result: the Accessibility driver, the JXA input helpers (each by path -
 * a bare `osascript` would run any AppleScript), screenshots, cropping them,
 * and the upload helper that can only post a file into a Slack thread.
 */
const executerBrowserTools = (opts: ToolPolicyOptions): readonly string[] => [
  // With the lock wrapper wired, the drivers are reachable only through it, so
  // an executer cannot drive the screen while another session holds it.
  ...(opts.desktopScript
    ? [`Bash(${opts.desktopScript}:*)`]
    : [
        ...(opts.macUiScript ? [`Bash(${opts.macUiScript}:*)`] : []),
        ...(opts.agentDesktop ? [`Bash(${opts.agentDesktop}:*)`] : []),
      ]),
  ...(opts.browserScripts ?? []).map((s) => `Bash(osascript -l JavaScript ${s}:*)`),
  ...(opts.uploadScript ? [`Bash(${opts.uploadScript}:*)`] : []),
  "Bash(screencapture:*)", "Bash(sips:*)",
];

/** Written history on a shared branch is not an executer's to rewrite. */
const NO_FORCE_PUSH: readonly string[] = [
  "Bash(git push --force:*)", "Bash(git push -f:*)", "Bash(git push --force-with-lease:*)",
];

/**
 * Paths an executer may never write, even with the code tools: the bot's own
 * source and the CLI's config. "Normal codebases" means everything else.
 */
const protectedWrites = (paths: readonly string[]): readonly string[] =>
  paths.flatMap((p) => {
    // permission rules read `~/x` from home and `//x` as an absolute path
    const dir = p.startsWith("~") ? p.replace(/\/+$/, "") : `/${p.replace(/\/+$/, "")}`;
    return [`Edit(${dir}/**)`, `Write(${dir}/**)`, `MultiEdit(${dir}/**)`];
  });

const FILE_WRITES: readonly string[] = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/**
 * Sandbox denials minus the read-only databases and the file writes an
 * executer is granted, plus the paths and pushes it stays out of.
 */
export const executerDisallow = (protectedPaths: readonly string[] = []): readonly string[] => [
  ...SANDBOX_DISALLOW.filter((t) => !EXECUTER_DB_SERVERS.includes(t) && !FILE_WRITES.includes(t)),
  "NotebookEdit",
  ...NO_FORCE_PUSH,
  ...protectedWrites(["~/.claude", ...protectedPaths]),
];


export type ToolPolicyOptions = {
  /** cwd for full-access roles (owner/admin). */
  readonly fullCwd?: string;
  /** fixed scratch dir for sandboxed roles (pal/executer). */
  readonly sandboxCwd?: string;
  /** tool allow-list for the executer role, assigned from the control deck. */
  readonly executerTools?: readonly string[];
  /** Absolute paths an executer may not write: the bot's own source. */
  readonly protectedPaths?: readonly string[];
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
  /**
   * Absolute path of the GitHub App comment helper. Granted to every role: it
   * can only post to the issue the turn's own thread was opened for, and only
   * with that turn's ticket.
   */
  readonly githubCommentScript?: string;
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
  /** Absolute path of the Accessibility driver (`bin/mac-ui.js`): executer only. */
  readonly macUiScript?: string;
  /** Absolute path of the agent-desktop binary, the second AX driver: executer only. */
  readonly agentDesktop?: string;
  /** Absolute path of `bin/desktop.ts`, the one-driver-at-a-time lock: replaces the two above. */
  readonly desktopScript?: string;
  /** Absolute paths of the JXA browser helpers (real click, keys): executer only. */
  readonly browserScripts?: readonly string[];
  /** Absolute path of the Slack thread upload helper: executer only. */
  readonly uploadScript?: string;
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
  /**
   * Extra denials from the role's dashboard policy (`domain/rolePolicy.ts`):
   * tools and whole MCP servers it may not use. Appended to every branch's
   * `--disallowedTools`, since a denial is the only lever that refuses.
   */
  readonly roleDisallow?: readonly string[];
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
  ...(opts.githubCommentScript ? [`Bash(${opts.githubCommentScript}:*)`] : []),
];

/** Channel beats role beats the adapter default. */
const modelOf = (role: UserRole, opts: ToolPolicyOptions): string | undefined =>
  opts.channelModel?.trim() || opts.models?.[role];

export const toolPolicyFor = (role: UserRole, opts: ToolPolicyOptions): ToolPolicy => {
  const base = basePolicyFor(role, opts);
  const extra = opts.roleDisallow ?? [];
  return extra.length
    ? { ...base, disallowedTools: [...new Set([...(base.disallowedTools ?? []), ...extra])] }
    : base;
};

const basePolicyFor = (role: UserRole, opts: ToolPolicyOptions): ToolPolicy => {
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
          [
            ...(opts.executerTools && opts.executerTools.length > 0 ? opts.executerTools : PAL_TOOLS),
            ...EXECUTER_DB_SERVERS,
            ...EXECUTER_CODE_TOOLS,
            ...executerBrowserTools(opts),
          ],
          opts,
        ),
        disallowedTools: executerDisallow(opts.protectedPaths),
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
