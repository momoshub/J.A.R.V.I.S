/**
 * Roles are data. Only `owner` is hard-coded: it always exists, always holds
 * every permission, and can never be restricted, renamed or deleted. Every
 * other role is a row (name, rank, description, the permissions it GRANTS) that
 * the owner edits; `pal`, `executer` and `admin` are just the roles seeded on
 * first boot (`roleSeed.ts`).
 *
 * Every role check in the bot is `can(book, role, permission)`. None compares a
 * role name - except `owner`, which is the one name that means something.
 */
import { isOwnerOnlyPermission } from "./permissions.ts";
import type { UserRole } from "./types.ts";

export const OWNER_ROLE = "owner";
/** The owner outranks every stored role. */
export const OWNER_RANK = 1_000_000;

export const isOwnerRole = (role: UserRole): boolean => role === OWNER_ROLE;

export type Role = {
  readonly name: UserRole;
  /** Higher outranks lower. A role may only manage people whose role ranks below its own. */
  readonly rank: number;
  readonly description: string;
  /** Off: its members are treated as not on the allowlist. The owner is always on. */
  readonly enabled: boolean;
  /** Permission ids this role grants (`permissions.ts`). */
  readonly grants: readonly string[];
  /** Extra CLI tool patterns (`Bash(rm:*)`) added to `--disallowedTools` for this role. */
  readonly deniedTools: readonly string[];
  /** Which default role this was seeded as (`pal`, `executer`, `admin`); absent for a custom one. */
  readonly seed?: string;
};

export type RoleBook = {
  /** A role by name; `owner` is always found. */
  readonly get: (name: UserRole) => Role | undefined;
  /** Every role, highest rank first, the owner included. */
  readonly list: () => readonly Role[];
};

/** The owner as the code sees it: everything, always. Never stored, never editable. */
export const OWNER: Role = {
  name: OWNER_ROLE,
  rank: OWNER_RANK,
  description: "Full control. Always exists, always holds every permission, cannot be restricted or deleted.",
  enabled: true,
  grants: ["*"],
  deniedTools: [],
};

/** A book over a fixed list (tests, and the default when nothing is wired). */
export const staticBook = (roles: readonly Role[]): RoleBook => {
  const byName = new Map<string, Role>([...roles.map((r) => [r.name, r] as const), [OWNER_ROLE, OWNER]]);
  const sorted = [...byName.values()].sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
  return { get: (name) => byName.get(name), list: () => sorted };
};

/** Does this role hold the permission? The owner holds all; an unknown or switched-off role holds none. */
export const can = (book: RoleBook, role: UserRole, permission: string): boolean => {
  if (role === OWNER_ROLE) return true;
  // Managing roles is the owner's alone, whatever a stored row says: a hand-edited grant cannot open it.
  if (isOwnerOnlyPermission(permission)) return false;
  const r = book.get(role);
  return !!r && r.enabled && r.grants.includes(permission);
};

export const rankOf = (book: RoleBook, role: UserRole): number => book.get(role)?.rank ?? -1;

/** Roles holding a permission, lowest rank first (what a refusal names). */
export const rolesWith = (book: RoleBook, permission: string): readonly Role[] =>
  [...book.list()].filter((r) => can(book, r.name, permission)).sort((a, b) => a.rank - b.rank);

/** Who holds a permission, for a refusal: "admin", "executer or admin". The owner is implied, so named only when nobody else holds it. */
export const roleNamesWith = (book: RoleBook, permission: string): string => {
  const others = rolesWith(book, permission).filter((r) => r.name !== OWNER_ROLE);
  const names = (others.length > 0 ? others : rolesWith(book, permission)).map((r) => r.name);
  return names.length <= 1 ? (names[0] ?? OWNER_ROLE) : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
};

const assignableRoles = (book: RoleBook): Role[] => book.list().filter((r) => r.name !== OWNER_ROLE && r.enabled);

/**
 * The least-privileged role: lowest rank, and among equals the one that grants least, so a new custom role
 * copied from `pal` never displaces `pal` as what an approved request lands on.
 */
export const lowestRole = (book: RoleBook): Role | undefined =>
  [...assignableRoles(book)].sort((a, b) => a.rank - b.rank || a.grants.length - b.grants.length || a.name.localeCompare(b.name))[0];

/** The most-privileged role below the owner: highest rank, then most grants. */
export const highestRole = (book: RoleBook): Role | undefined =>
  [...assignableRoles(book)].sort((a, b) => b.rank - a.rank || b.grants.length - a.grants.length || a.name.localeCompare(b.name))[0];

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
/** Words the `role` command itself uses; a role with one of these names could not be addressed. */
const RESERVED = new Set(["list", "show", "create", "grant", "revoke", "delete", "rename", "describe", "rank", "on", "off", "from", "all", "help"]);

/** A role name someone may create: lowercase word, not `owner`, not a `role` subcommand. */
export const validRoleName = (name: string): string | undefined => {
  const n = name.trim().toLowerCase();
  if (n === OWNER_ROLE) return "`owner` is built in and cannot be created or replaced.";
  if (!NAME.test(n)) return "A role name is 1-32 characters: a letter first, then letters, digits, `-` or `_`.";
  if (RESERVED.has(n)) return `\`${n}\` is a word the \`role\` command uses - pick another name.`;
  return undefined;
};

/**
 * May `actor` set a target's role from `current` to `next` (or remove them,
 * `next` undefined)? The owner can always, except for the owner's own record.
 * Anyone else only manages roles that rank strictly BELOW their own - so an
 * admin cannot touch another admin or hand out the admin role, and nobody
 * reaches past what they are.
 */
export const mayAssign = (
  book: RoleBook,
  actor: UserRole,
  current: UserRole | undefined,
  next: UserRole | undefined,
): string | undefined => {
  if (next === OWNER_ROLE) return "There can only be one owner.";
  if (actor === OWNER_ROLE) return undefined;
  const mine = rankOf(book, actor);
  if (current !== undefined && rankOf(book, current) >= mine) return "Only someone who outranks that role can change it.";
  if (next !== undefined && rankOf(book, next) >= mine) return "You can only hand out roles that rank below your own.";
  return undefined;
};

/**
 * A role cannot grant what its editor does not hold. The owner holds everything,
 * so this only bites for a future where someone below the owner may edit roles:
 * it is the guard that keeps role management from becoming a ladder.
 */
export const ungrantable = (book: RoleBook, editor: UserRole, permissions: readonly string[]): readonly string[] =>
  permissions.filter((p) => !can(book, editor, p));
