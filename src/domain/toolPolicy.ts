/**
 * Per-role tool policy for the Claude CLI brain.
 *
 * - owner / admin: full access (skip permissions, any tool, the normal cwd)
 * - pal: sandboxed read-only tools in a fixed scratch dir (may still use `review`)
 * - executer: sandboxed, tools assigned from the control deck, plus the read-only databases
 *   and the code tools - edit files, commit, push a branch and open a PR - the
 *   Agent/Task tool for parallel or long work in its own process, and the
 *   browser tools to test a UI change on the host Mac
 *
 * Orca is the owner's alone: a worker runs with full permissions on the host,
 * so a role that can start one escapes its own sandbox (`ORCA_DENY`).
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

/**
 * Orca starts workers with full permissions on the host Mac, so any role that
 * could run it would step out of its own sandbox. Denied by name to every role
 * but owner - an allow-list never refuses (see noTools), only a denial does.
 * Both the bare name and the installed paths, because a rule matches the
 * command as typed: the symlink the bot uses and the app's own binary.
 */
export const ORCA_DENY: readonly string[] = [
  "Bash(orca:*)",
  "Bash(/opt/homebrew/bin/orca:*)",
  "Bash(/Applications/Orca.app/Contents/Resources/bin/orca:*)",
  "Bash(~/Applications/Orca.app/Contents/Resources/bin/orca:*)",
];

/** Orca is for the owner only. Everyone else uses the Agent tool in their own process. */
export const mayUseOrca = (role: UserRole): boolean => role === "owner";

export const ALWAYS_DISALLOW: readonly string[] = [
  ...SLACK_CONNECTOR_WRITES,
  "Bash(aws logs:*)",
  "Bash(aws cloudwatch:*)",
];

/**
 * Local database MCP servers configured on the host: `DB_MCP_SERVERS` in the
 * environment, passed in by the caller (the domain reads no config).
 *
 * These are NOT claude.ai connectors, and the difference matters: a
 * `claude setup-token` credential strips the claude.ai ones (verified - zero
 * `mcp__` tools under one), but a LOCAL stdio server is just a process, and it
 * loads whatever credential the turn holds. Measured after installing these: a
 * setup-token turn ran `select 1` against the production read replica and got
 * its row back. So every turn reaches production SQL unless something refuses
 * it, and an allow-list does not refuse (see noTools).
 *
 * They must be named one by one. A bare `mcp__` prefix denies NOTHING -
 * measured with exactly that flag, and the query ran anyway - so a denial has
 * to name the server. Which means the list does not maintain itself: a new
 * database server added to `~/.claude.json` is reachable by every role until
 * its name is added to `DB_MCP_SERVERS`. An empty list denies nothing.
 */
export const dbServerTools = (names: readonly string[]): readonly string[] => [
  ...new Set(
    names
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => (n.startsWith("mcp__") ? n : `mcp__${n}`)),
  ),
];

/**
 * The Notion MCP server configured on the host (`claude mcp add --scope user
 * --transport http notion https://mcp.notion.com/mcp`, then authenticated once;
 * user scope, because a turn's cwd varies by role).
 *
 * The claude.ai Notion CONNECTOR cannot reach a chat turn - its authorisation
 * lives on the account, and a `claude setup-token` credential carries none. A
 * server registered in the host's own MCP config is the same kind of thing as
 * the database servers above: a configured server the turn loads on whatever
 * credential it holds, so a chat turn gets the whole toolset (search, fetch,
 * create and update pages INCLUDING properties such as Status, comments).
 *
 * It writes under the host's Notion identity, exactly like `note`, so it is
 * gated by the same floor (`note_min_role`, default admin) rather than being
 * open to every role: below the floor it is denied by name, at or above it a
 * sandboxed role gets it pre-approved.
 */
export const NOTION_MCP_SERVER = "mcp__notion";

/**
 * The Datadog MCP server configured on the host (`claude mcp add --scope user
 * --transport http datadog https://mcp.datadoghq.com/v1/mcp`, then authenticated
 * once with OAuth in a browser).
 *
 * Same story as Notion: the claude.ai Datadog CONNECTOR cannot reach a chat
 * turn, so until a server lived in the host's own MCP config only `investigate`
 * (host login) could read logs, RUM, spans or metrics. Unlike Notion it has no
 * floor: it is read only, and every role may look. "Read only" is enforced by
 * name, because an allow-list does not refuse: the tools that change a notebook
 * or dashboard are denied to every role, and so is `execute_code`, a sandbox
 * that can call the write endpoints too. Reads go through the named search/get
 * tools instead.
 */
export const DATADOG_MCP_SERVER = "mcp__datadog";

export const DATADOG_READ_TOOLS: readonly string[] = [
  "search_datadog_logs", "analyze_datadog_logs",
  "search_datadog_rum_events", "aggregate_rum_events",
  "search_datadog_spans", "aggregate_spans", "get_datadog_trace",
  "search_datadog_metrics", "get_datadog_metric", "get_datadog_metric_context",
  "search_datadog_events", "aggregate_events",
  "search_datadog_monitors", "search_datadog_hosts", "search_datadog_entities",
  "search_datadog_incidents", "get_datadog_incident", "get_change_stories",
  "search_datadog_dashboards", "get_datadog_dashboard",
  "search_datadog_notebooks", "get_datadog_notebook",
  "list_datadog_skills", "load_datadog_skill", "search_datadog_sdk",
].map((t) => `${DATADOG_MCP_SERVER}__${t}`);

export const DATADOG_WRITE_TOOLS: readonly string[] = [
  "create_datadog_notebook", "edit_datadog_notebook", "delete_datadog_notebook",
  "recover_datadog_notebook", "upsert_datadog_dashboard", "execute_code",
  "submit_mcp_feedback",
].map((t) => `${DATADOG_MCP_SERVER}__${t}`);

const ROLE_RANK: Record<UserRole, number> = { pal: 0, executer: 1, admin: 2, owner: 3 };

/** The default floor of `note`: it writes with the host's Notion identity. */
export const DEFAULT_NOTION_FLOOR: UserRole = "admin";

export const mayUseNotion = (role: UserRole, floor: UserRole = DEFAULT_NOTION_FLOOR): boolean =>
  ROLE_RANK[role] >= ROLE_RANK[floor];

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
export const noTools = (dbServers: readonly string[]): readonly string[] => [
  "Bash", "Task", "Agent",
  "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead",
  "Glob", "Grep", "LS", "TodoWrite",
  "WebFetch", "WebSearch",
  // A side question running a production query is the opposite of an aside.
  ...dbServerTools(dbServers),
  NOTION_MCP_SERVER,
  DATADOG_MCP_SERVER,
];

/**
 * Additionally denied to sandboxed roles: writes, secret reads, and the
 * databases.
 *
 * The database servers are here rather than merely absent from `PAL_TOOLS`
 * because absence is not a denial - that is the whole lesson of `noTools`.
 * A `pal` is the lowest trust level the bot has and most of the workspace is
 * one; arbitrary SQL against the production replica is not theirs to run, and
 * `investigate` (host login, admin-gated) is the route when it is needed.
 */
export const sandboxDisallow = (dbServers: readonly string[]): readonly string[] => [
  ...ALWAYS_DISALLOW,
  ...ORCA_DENY,
  "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Bash(aws secretsmanager:*)", "Bash(aws ssm get-parameter:*)", "Bash(aws kms:*)",
  ...dbServerTools(dbServers),
];

/**
 * What an executer needs to change an ordinary codebase: write files in a
 * clone, commit, push a branch and open a PR. Merging is not on it, and a
 * force push is denied below - review stays a human step.
 */
export const EXECUTER_CODE_TOOLS: readonly string[] = [
  // Subagents run in the turn's own process and inherit its permissions, so
  // they are how an executer fans out or runs long work without Orca. Named
  // here, not left to the dashboard tool list, which replaces PAL_TOOLS when set.
  "Task", "Agent",
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
export const executerDisallow = (
  protectedPaths: readonly string[] = [],
  dbServers: readonly string[] = [],
  executerDbServers: readonly string[] = [],
): readonly string[] => [
  ...sandboxDisallow(dbServers).filter(
    (t) => !dbServerTools(executerDbServers).includes(t) && !FILE_WRITES.includes(t),
  ),
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
   * Local database MCP servers (`DB_MCP_SERVERS`), denied to every sandboxed
   * role by name. Absent or empty denies none - see `dbServerTools`.
   */
  readonly dbServers?: readonly string[];
  /**
   * The subset of `dbServers` an executer may query (`EXECUTER_DB_MCP_SERVERS`):
   * only servers whose credential is read only on the server side. Absent
   * means an executer gets none.
   */
  readonly executerDbServers?: readonly string[];
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
  /**
   * Absolute path of the GitHub App action helper. Granted to every role like
   * the others: the bot checks the admin role of the turn's ticket holder
   * before it does anything, so the grant itself carries no authority.
   */
  readonly githubAppScript?: string;
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
  /**
   * Lowest role that may use the host's Notion MCP server (`note`'s floor).
   * Absent means the default, admin.
   */
  readonly notionFloor?: UserRole;
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
  ...(opts.githubAppScript ? [`Bash(${opts.githubAppScript}:*)`] : []),
];

/** Channel beats role beats the adapter default. */
const modelOf = (role: UserRole, opts: ToolPolicyOptions): string | undefined =>
  opts.channelModel?.trim() || opts.models?.[role];

export const toolPolicyFor = (role: UserRole, opts: ToolPolicyOptions): ToolPolicy => {
  const base = basePolicyFor(role, opts);
  // Below the floor the server is denied by name (an allow-list never refuses).
  const extra = [
    ...(opts.roleDisallow ?? []),
    ...(mayUseNotion(role, opts.notionFloor) ? [] : [NOTION_MCP_SERVER]),
    ...DATADOG_WRITE_TOOLS,
  ];
  return extra.length
    ? { ...base, disallowedTools: [...new Set([...(base.disallowedTools ?? []), ...extra])] }
    : base;
};

/** Pre-approval for a sandboxed role at or above the Notion floor. */
const notionAllow = (role: UserRole, opts: ToolPolicyOptions): readonly string[] =>
  mayUseNotion(role, opts.notionFloor) ? [NOTION_MCP_SERVER] : [];

const basePolicyFor = (role: UserRole, opts: ToolPolicyOptions): ToolPolicy => {
  switch (role) {
    case "owner":
    case "admin":
      return {
        skipPermissions: true,
        cwd: opts.fullCwd,
        model: modelOf(role, opts),
        // Full access still does not mean "post as a human" or "bill us per query",
        // and only the owner may start Orca workers.
        disallowedTools: mayUseOrca(role) ? ALWAYS_DISALLOW : [...ALWAYS_DISALLOW, ...ORCA_DENY],
      };
    case "executer":
      return {
        skipPermissions: false,
        cwd: opts.sandboxCwd,
        allowedTools: withHelpers(
          [
            ...(opts.executerTools && opts.executerTools.length > 0 ? opts.executerTools : PAL_TOOLS),
            ...dbServerTools(opts.executerDbServers ?? []),
            ...EXECUTER_CODE_TOOLS,
            ...executerBrowserTools(opts),
            ...notionAllow(role, opts),
            ...DATADOG_READ_TOOLS,
          ],
          opts,
        ),
        disallowedTools: executerDisallow(opts.protectedPaths, opts.dbServers, opts.executerDbServers),
        model: modelOf("executer", opts),
      };
    case "pal":
    default:
      return {
        skipPermissions: false,
        cwd: opts.sandboxCwd,
        allowedTools: withHelpers([...PAL_TOOLS, ...notionAllow(role, opts), ...DATADOG_READ_TOOLS], opts),
        disallowedTools: sandboxDisallow(opts.dbServers ?? []),
        model: modelOf("pal", opts),
      };
  }
};
