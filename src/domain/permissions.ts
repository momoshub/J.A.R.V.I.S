/**
 * The permissions a role can be granted. A permission is a plain string id:
 *
 * - `command:<name>`   run that command (the command's own `minRole` is only the seed default)
 * - `github:<action>`  act on GitHub as the App (`pr-create`, `comment`, ..., `git`, `push`)
 * - `mcp:<server>`     use that MCP server in a chat turn (denied by name when absent)
 * - the named ones below: tool tiers, and the guarded sub-actions that used to be `role >= admin`
 *
 * Only `owner` is exempt: it holds all of them without a row. Which ones are
 * OWNER-ONLY on top (never grantable, never held by anyone else) is `OWNER_ONLY`.
 */
export const PERM = {
  /** Chat turns run the CLI with full access (any tool, the normal cwd) instead of sandboxed. */
  fullAccess: "tools:full-access",
  /** Sandboxed code tools: edit files, commit, push a branch, open a PR, subagents, browser tools. */
  code: "tools:code",
  /** Start Orca workers: they run with full permissions on the host, so this steps out of any sandbox. */
  orca: "tools:orca",
  /** Be told about, and use, the bot's self-update flow, learn url and watches in chat. */
  selfUpdate: "chat:self-update",
  /** Drive the real screen (Accessibility drivers, browser helpers). */
  desktop: "chat:desktop",
  /** Not held back by the per-window command allowance. */
  unlimited: "commands:unlimited",
  /** Press the approve / reject buttons on a held command. */
  approveCommands: "commands:approve",
  /** Decide an access request (react on the request, add the asker). */
  decideAccess: "access:decide",
  /** Change bot configuration through commands: model, review-agents, review inbox, policies, allowances, default log group... */
  manageSettings: "settings:manage",
  /** Set a review policy or approve up front in `quick-review` (a role without it always waits for a clean review). */
  reviewPolicy: "review:policy",
  /** Stop or reset someone else's running turn or thread session. */
  stopAny: "runs:stop-any",
  /** Add and remove 2FA setup keys. */
  twoFa: "secrets:2fa-manage",
  /** Create a `watch` whose check is a shell command, and see everyone's watches. */
  shellWatch: "watch:shell",
  /** List and cancel everyone's reminders. */
  manageReminders: "reminders:manage-all",
  /** Add, update, finish and drop journeys; listing them is open to anyone who may run `journey`. */
  writeJourneys: "journeys:write",
  /** `cloudwatch` runs straight away with the cost warning; without it the request waits for Confirm. */
  cloudwatchDirect: "cloudwatch:direct",
} as const;

export const commandPerm = (name: string): string => `command:${name}`;
export const githubPerm = (action: string): string => `github:${action}`;
export const mcpPerm = (server: string): string => `mcp:${server.replace(/^mcp__/, "")}`;

/** GitHub App actions a role can be granted. `git` and `push` both mint the installation token (`git-auth`). */
export const GITHUB_PERMISSION_ACTIONS = [
  "pr-create", "comment", "review", "pr-edit", "pr-close", "pr-reopen", "pr-merge",
  "labels-add", "labels-remove", "reviewers-request", "git", "push",
] as const;

/**
 * Permissions that only the owner ever holds and nobody can be granted: managing roles
 * themselves. `role` (create / grant / revoke / delete) is owner-only in code, so a role
 * can never be handed the power to hand out more.
 */
export const OWNER_ONLY_COMMANDS: readonly string[] = ["role"];

export const isOwnerOnlyPermission = (perm: string): boolean =>
  OWNER_ONLY_COMMANDS.some((c) => perm === commandPerm(c));

const NAMED_LABELS: Record<string, string> = {
  [PERM.fullAccess]: "Chat turns run with full access (any tool, normal working directory)",
  [PERM.code]: "Sandboxed code tools: edit files, commit, push a branch, open a PR, subagents, browser tools",
  [PERM.orca]: "Start Orca workers (they run with full permissions on the host)",
  [PERM.selfUpdate]: "Self-update flow, learn url and watches offered in chat",
  [PERM.desktop]: "Drive the screen (Accessibility drivers)",
  [PERM.unlimited]: "Not held back by the command allowance",
  [PERM.approveCommands]: "Approve or reject a held command",
  [PERM.decideAccess]: "Decide access requests",
  [PERM.manageSettings]: "Change bot configuration through commands",
  [PERM.reviewPolicy]: "Set a review policy / approve up front",
  [PERM.stopAny]: "Stop or reset someone else's turn or session",
  [PERM.twoFa]: "Add and remove 2FA setup keys",
  [PERM.shellWatch]: "Shell-check watches, and see everyone's watches",
  [PERM.manageReminders]: "List and cancel everyone's reminders",
  [PERM.writeJourneys]: "Add, update, finish and drop journeys",
  [PERM.cloudwatchDirect]: "CloudWatch runs directly, no Confirm step",
};

export type PermissionInfo = { readonly id: string; readonly group: string; readonly label: string };

/** Every permission a role can be granted, grouped, for `role show` and the dashboard. */
export const permissionCatalogue = (input: {
  readonly commands: readonly { readonly name: string; readonly summary: string }[];
  readonly mcpServers: readonly string[];
}): readonly PermissionInfo[] => [
  ...input.commands
    .filter((c) => !isOwnerOnlyPermission(commandPerm(c.name)))
    .map((c) => ({ id: commandPerm(c.name), group: "Commands", label: c.summary })),
  ...GITHUB_PERMISSION_ACTIONS.map((a) => ({ id: githubPerm(a), group: "GitHub App", label: `act as the App: ${a}` })),
  ...Object.entries(NAMED_LABELS).map(([id, label]) => ({
    id,
    group: id.startsWith("tools:") ? "Tools" : "Other",
    label,
  })),
  ...input.mcpServers.map((s) => ({ id: mcpPerm(s), group: "MCP servers", label: `use the ${s} MCP server` })),
];

/** Whether an id is something a role may hold, given the catalogue. */
export const isKnownPermission = (perm: string, catalogue: readonly PermissionInfo[]): boolean =>
  catalogue.some((p) => p.id === perm);
