/**
 * What a role being switched off, or denied a tool, means where the allowlist is
 * read. The roles themselves - their ranks and what each grants - are data
 * (`domain/roles.ts`); this keeps the few rules that sit around a role record.
 *
 * A switched-off role grants nothing: its members are treated as not on the
 * allowlist. The owner role is always on, whatever is stored, so a bad save can
 * never lock the owner out of their own bot.
 */
import { OWNER_ROLE, type RoleBook } from "./roles.ts";
import type { AllowedUser, UserRole } from "./types.ts";

/** Highest first, as `role list` and the dashboard show them. */
export const roleNames = (book: RoleBook): readonly UserRole[] => book.list().map((r) => r.name);

export const isRoleEnabled = (book: RoleBook, role: UserRole): boolean =>
  role === OWNER_ROLE || (book.get(role)?.enabled ?? false);

/**
 * The user as access control should see them: absent when their role is off (or
 * no longer exists). Every role check in the bot reads users through this, so a
 * disabled role cannot grant anything anywhere - chat, commands, buttons, GitHub calls.
 */
export const enforcedUser = (user: AllowedUser | undefined, book: RoleBook): AllowedUser | undefined =>
  user && isRoleEnabled(book, user.role) ? user : undefined;

/** `help` stays reachable: it is how anyone finds out what they can still do. */
export const UNDENIABLE_COMMANDS: readonly string[] = ["help"];

/**
 * A stored command name carried over a rename: `review` is now `quick-review`.
 * `approve` was a different command (a bare approval), not a rename, so it maps
 * to nothing and is dropped - denying or disabling it never meant a review.
 */
export const currentCommandName = (name: string): string | undefined => {
  const n = name.trim().toLowerCase();
  if (n === "approve") return undefined;
  return n === "review" ? "quick-review" : n;
};

export const mcpServerTool = (server: string): string => `mcp__${server.replace(/^mcp__/, "")}`;

/** The built-in CLI tools offered as checkboxes for a role's extra denials. Anything else is a free-text pattern. */
export const CORE_TOOLS: readonly string[] = [
  "Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite",
];

const TOOL_PATTERN = /^[A-Za-z][\w-]*(\([^()\n]{1,300}\))?$/;

/** Check a list of CLI tool patterns typed or posted for a role's extra denials. */
export const parseDeniedTools = (v: unknown): { ok: true; tools: string[] } | { ok: false; error: string } => {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n]/) : [];
  const tools = [...new Set(raw.map((s) => String(s ?? "").trim()).filter(Boolean))];
  const bad = tools.find((t) => !TOOL_PATTERN.test(t));
  return bad ? { ok: false, error: `Not a tool name or pattern: ${bad}` } : { ok: true, tools };
};

/** What a member of a switched-off role is told, instead of being raised as an access request. */
export const disabledRoleReason = (role: UserRole): string =>
  `The ${role} role is switched off right now, so I cannot help you. Ask the owner if you think that is a mistake.`;
