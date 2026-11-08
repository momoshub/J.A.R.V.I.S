/**
 * Per-role policy edited from the dashboard: whether a role is switched on,
 * and what it is refused on top of what the code already refuses it.
 *
 * The four roles and their order stay in code (`pal` < `executer` < `admin` <
 * `owner`), and so does every ceiling - a command's `minRole`, the sandbox
 * deny lists. A policy only ever takes away: it can switch a role off, deny a
 * command the role could otherwise run, deny a tool, deny an MCP server. It can
 * never grant past a ceiling, because those ceilings carry reasons (a `watch`
 * predicate is a shell command, a database server reaches production) that a
 * checkbox should not be able to undo.
 *
 * The owner role is never restricted: whatever is stored for it is ignored, so
 * a bad save can never lock the owner out of their own bot.
 */
import type { AllowedUser, UserRole } from "./types.ts";
import { DB_MCP_SERVERS, PAL_TOOLS } from "./toolPolicy.ts";

export type RolePolicy = {
  readonly role: UserRole;
  /** Off means the role grants nothing: its members are treated as not on the allowlist. */
  readonly enabled: boolean;
  /** Command names this role may not run, even when its rank reaches `minRole`. */
  readonly deniedCommands: readonly string[];
  /** CLI tool names or patterns (`Bash`, `Bash(rm:*)`) added to `--disallowedTools`. */
  readonly deniedTools: readonly string[];
  /** MCP server names (bare, no `mcp__`) denied whole. */
  readonly deniedMcpServers: readonly string[];
};

/** Highest first, the order the dashboard lists them in. */
export const ROLES: readonly UserRole[] = ["owner", "admin", "executer", "pal"];

export const isRole = (v: unknown): v is UserRole => typeof v === "string" && (ROLES as readonly string[]).includes(v);

export const defaultRolePolicy = (role: UserRole): RolePolicy => ({
  role,
  enabled: true,
  deniedCommands: [],
  deniedTools: [],
  deniedMcpServers: [],
});

/** The owner role is always on and never restricted, whatever is stored. */
export const effectivePolicy = (policy: RolePolicy): RolePolicy =>
  policy.role === "owner" ? defaultRolePolicy("owner") : policy;

export const isRoleEnabled = (policy: RolePolicy): boolean => effectivePolicy(policy).enabled;

/**
 * The user as access control should see them: absent when their role is off.
 * Every role check in the bot reads users through this, so a disabled role
 * cannot grant anything anywhere - chat, commands, buttons, GitHub calls.
 */
export const enforcedUser = (
  user: AllowedUser | undefined,
  policyOf: (role: UserRole) => RolePolicy,
): AllowedUser | undefined => (user && isRoleEnabled(policyOf(user.role)) ? user : undefined);

/** `help` stays reachable: it is how anyone finds out what they can still do. */
export const UNDENIABLE_COMMANDS: readonly string[] = ["help"];

export const isCommandDenied = (policy: RolePolicy, name: string): boolean => {
  const p = effectivePolicy(policy);
  return !UNDENIABLE_COMMANDS.includes(name) && p.deniedCommands.includes(name);
};

export const mcpServerTool = (server: string): string => `mcp__${server.replace(/^mcp__/, "")}`;

/** What the policy adds to `--disallowedTools` for a turn of this role. */
export const policyDisallow = (policy: RolePolicy): readonly string[] => {
  const p = effectivePolicy(policy);
  return [...p.deniedTools, ...p.deniedMcpServers.map(mcpServerTool)];
};

/** The built-in CLI tools offered as checkboxes. Anything else is a free-text pattern. */
export const CORE_TOOLS: readonly string[] = [
  "Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite",
];

/** `mcp__server` or `mcp__server__tool` -> `server`. */
const serverOf = (tool: string): string | undefined =>
  tool.startsWith("mcp__") ? tool.slice("mcp__".length).split("__")[0] || undefined : undefined;

/**
 * MCP servers the dashboard offers: the database servers the code knows, the
 * connectors the read-only tool set names, and anything a policy already
 * denies (so a server typed in by hand stays visible once saved).
 */
export const knownMcpServers = (policies: readonly RolePolicy[]): string[] => {
  const fromTools = [...DB_MCP_SERVERS, ...PAL_TOOLS.filter((t) => t.startsWith("mcp__"))]
    .map(serverOf)
    .filter((s): s is string => !!s);
  const fromPolicies = policies.flatMap((p) => p.deniedMcpServers);
  return [...new Set([...fromTools, ...fromPolicies])].sort();
};

const TOOL_PATTERN = /^[A-Za-z][\w-]*(\([^()\n]{1,300}\))?$/;
const MCP_SERVER = /^[A-Za-z0-9][\w.-]{0,99}$/;
const COMMAND_NAME = /^[a-z][\w-]{0,40}$/;

const listOf = (v: unknown): string[] => {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n]/) : [];
  return [...new Set(raw.map((s) => String(s ?? "").trim()).filter(Boolean))];
};

export type PolicyCheck = { readonly ok: true; readonly policy: RolePolicy } | { readonly ok: false; readonly error: string };

/**
 * Check a policy that arrived off a JSON body. `knownCommands` is the command
 * registry, so a typo is refused instead of silently denying nothing.
 */
export const parseRolePolicy = (
  input: {
    readonly role: unknown;
    readonly enabled: unknown;
    readonly deniedCommands: unknown;
    readonly deniedTools: unknown;
    readonly deniedMcpServers: unknown;
  },
  knownCommands: readonly string[],
): PolicyCheck => {
  if (!isRole(input.role)) return { ok: false, error: "Unknown role" };
  if (input.role === "owner") return { ok: false, error: "The owner role cannot be restricted" };
  const deniedCommands = [...new Set(listOf(input.deniedCommands).map((c) => c.toLowerCase()))];
  const badCommand = deniedCommands.find((c) => !COMMAND_NAME.test(c) || !knownCommands.includes(c));
  if (badCommand) return { ok: false, error: `Unknown command: ${badCommand}` };
  if (deniedCommands.some((c) => UNDENIABLE_COMMANDS.includes(c))) {
    return { ok: false, error: "`help` cannot be denied" };
  }
  const deniedTools = listOf(input.deniedTools);
  const badTool = deniedTools.find((t) => !TOOL_PATTERN.test(t));
  if (badTool) return { ok: false, error: `Not a tool name or pattern: ${badTool}` };
  const deniedMcpServers = listOf(input.deniedMcpServers).map((s) => s.replace(/^mcp__/, ""));
  const badServer = deniedMcpServers.find((s) => !MCP_SERVER.test(s));
  if (badServer) return { ok: false, error: `Not an MCP server name: ${badServer}` };
  return {
    ok: true,
    policy: {
      role: input.role,
      enabled: input.enabled !== false,
      deniedCommands,
      deniedTools,
      deniedMcpServers: [...new Set(deniedMcpServers)],
    },
  };
};

/** What a member of a switched-off role is told, instead of being raised as an access request. */
export const disabledRoleReason = (role: UserRole): string =>
  `The ${role} role is switched off right now, so I cannot help you. Ask the owner if you think that is a mistake.`;
