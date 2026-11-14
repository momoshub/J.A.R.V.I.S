/**
 * Roles as data: seeding the built-ins, and the owner's edits.
 *
 * `seedRoles` runs at boot. The first time (no `roles` rows) it writes `pal`,
 * `executer` and `admin` with the grants that reproduce the old behaviour and
 * folds the old dashboard deny lists (`role_policies`) and the `note` / `read`
 * floors in, so a deploy changes nothing for anyone. Every later boot seeds only
 * permissions that did not exist before (a new command), into the built-in roles
 * only, so a revoke made by the owner sticks and a custom role is never widened
 * behind its owner's back.
 *
 * The edit functions never throw: each returns `{ ok: true, ... }` or the reason.
 * Who may call them (the owner, always) is the caller's business - `role` is an
 * owner-only command and the dashboard refuses anyone else.
 */
import {
  GITHUB_PERMISSION_ACTIONS,
  PERM,
  commandPerm,
  githubPerm,
  isKnownPermission,
  isOwnerOnlyPermission,
  mcpPerm,
  permissionCatalogue,
  type PermissionInfo,
} from "../domain/permissions.ts";
import { OWNER_ROLE, lowestRole, ungrantable, validRoleName, type Role, type RoleBook } from "../domain/roles.ts";
import { builtinRoles, defaultGrants, mcpCatalogue, type SeedInput } from "../domain/roleSeed.ts";
import { mcpServerTool } from "../domain/rolePolicy.ts";
import type { UserRole } from "../domain/types.ts";
import type { RoleRepo } from "../infrastructure/db/roleRepo.ts";
import { SETTING_KEYS, type SettingsRepo } from "../infrastructure/db/settingsRepo.ts";
import type { LegacyRolePolicy } from "../infrastructure/db/rolePolicyRepo.ts";

/** The two settings calls the role editor needs; the dashboard hands in a narrower port than the full repo. */
export type SettingsLike = Pick<SettingsRepo, "get" | "set">;

export type SeedDeps = {
  readonly repo: RoleRepo;
  readonly settings: SettingsRepo;
  readonly clock: () => number;
  /** The old deny lists, read once to fold into the grants. */
  readonly legacyPolicies: () => readonly LegacyRolePolicy[];
  readonly input: () => SeedInput;
};

const list = (v: string | undefined): string[] =>
  (v ?? "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

/** Every permission id the code knows about, for the "already seeded" bookkeeping. */
export const allPermissionIds = (input: SeedInput): string[] => [
  ...input.commands.map((c) => commandPerm(c.name)),
  ...GITHUB_PERMISSION_ACTIONS.map(githubPerm),
  ...Object.values(PERM),
  ...mcpCatalogue({ dbServers: [...input.dbServers, ...input.executerDbServers], extraMcpServers: input.extraMcpServers }).map(mcpPerm),
];

const seededBefore = (settings: SettingsRepo): Set<string> => {
  try {
    const v: unknown = JSON.parse(settings.get(SETTING_KEYS.rolesSeededPerms) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
};

/** The first-boot seed: the built-ins, with the old deny policies and floors folded in. */
const firstSeed = (deps: SeedDeps): void => {
  const floorOf = (key: string): string | undefined => {
    const v = deps.settings.get(key)?.trim().toLowerCase();
    return v && ["pal", "executer", "admin", "owner"].includes(v) ? v : undefined;
  };
  const policies = deps.legacyPolicies();
  // A server a policy denied that the host does not list is still a server: keep it in the catalogue so the denial survives.
  const extras = new Set(list(deps.settings.get(SETTING_KEYS.roleMcpServers)));
  for (const p of policies) for (const s of p.deniedMcpServers) extras.add(s.replace(/^mcp__/, ""));
  if (extras.size > 0) deps.settings.set(SETTING_KEYS.roleMcpServers, [...extras].sort().join(","));
  const input: SeedInput = {
    ...deps.input(),
    extraMcpServers: [...new Set([...deps.input().extraMcpServers, ...extras])],
    floors: { note: floorOf(SETTING_KEYS.noteMinRole), read: floorOf(SETTING_KEYS.readMinRole) },
  };
  const at = deps.clock();
  for (const role of builtinRoles(input)) {
    const policy = policies.find((p) => p.role === role.name);
    const deniedCmds = new Set((policy?.deniedCommands ?? []).map(commandPerm));
    const deniedMcp = new Set((policy?.deniedMcpServers ?? []).map((s) => mcpPerm(s)));
    deps.repo.save(
      {
        ...role,
        enabled: policy ? policy.enabled : true,
        grants: role.grants.filter((g) => !deniedCmds.has(g) && !deniedMcp.has(g)),
        deniedTools: policy?.deniedTools ?? [],
      },
      "migration",
      at,
    );
  }
  deps.settings.set(SETTING_KEYS.rolesSeededPerms, JSON.stringify(allPermissionIds(input).sort()));
};

/** Grants a stored role may still carry from a command that became internal (`journey`); nothing reads them, so boot drops them. */
export const RETIRED_GRANTS: readonly string[] = ["journeys:write", commandPerm("journey")];

const dropRetiredGrants = (deps: SeedDeps): void => {
  const at = deps.clock();
  for (const role of deps.repo.stored()) {
    if (!role.grants.some((g) => RETIRED_GRANTS.includes(g))) continue;
    deps.repo.save({ ...role, grants: role.grants.filter((g) => !RETIRED_GRANTS.includes(g)) }, "seed", at);
  }
};

/** Seed what is missing. Safe to run on every boot. */
export const seedRoles = (deps: SeedDeps): void => {
  if (deps.repo.stored().length === 0) {
    firstSeed(deps);
    return;
  }
  dropRetiredGrants(deps);
  const input = deps.input();
  const seen = seededBefore(deps.settings);
  const fresh = allPermissionIds(input).filter((p) => !seen.has(p));
  if (fresh.length === 0) return;
  const at = deps.clock();
  for (const role of deps.repo.stored()) {
    if (!role.seed) continue;
    const add = defaultGrants(role.seed, input).filter((g) => fresh.includes(g) && !role.grants.includes(g));
    if (add.length > 0) deps.repo.save({ ...role, grants: [...role.grants, ...add] }, "seed", at);
  }
  deps.settings.set(SETTING_KEYS.rolesSeededPerms, JSON.stringify([...new Set([...seen, ...fresh])].sort()));
};

/** The role approvals from an access request grant: the setting, else the lowest-ranked role. */
export const defaultRoleOf = (book: RoleBook, settings?: Pick<SettingsRepo, "get">): UserRole | undefined => {
  const named = settings?.get(SETTING_KEYS.defaultRole)?.trim();
  if (named && book.get(named) && named !== OWNER_ROLE) return named;
  return lowestRole(book)?.name;
};

/** Every grantable permission, grouped, for `role show` and the dashboard. */
export const catalogueFor = (
  input: SeedInput,
  commands: readonly { name: string; summary: string }[],
): readonly PermissionInfo[] =>
  permissionCatalogue({
    commands,
    mcpServers: mcpCatalogue({ dbServers: [...input.dbServers, ...input.executerDbServers], extraMcpServers: input.extraMcpServers }),
  });

export type RoleResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export type RoleEditDeps = {
  readonly repo: RoleRepo;
  readonly settings?: SettingsLike;
  readonly clock: () => number;
  /** Who is editing (a Slack id, or `dashboard`). */
  readonly by: string;
  /** The role of whoever edits. Only the owner reaches this, but a role cannot grant what its editor lacks. */
  readonly editor: UserRole;
  readonly catalogue: readonly PermissionInfo[];
};

/** `command:*`, `github:*`, `mcp:*`, `tools:*` expand to the matching ids; a plain id stays. */
export const expandPermissions = (tokens: readonly string[], catalogue: readonly PermissionInfo[]): string[] => {
  const out = new Set<string>();
  for (const t of tokens) {
    const token = t.trim().toLowerCase();
    if (!token) continue;
    if (token.endsWith(":*")) {
      const prefix = token.slice(0, -1);
      for (const p of catalogue) if (p.id.startsWith(prefix) && !isOwnerOnlyPermission(p.id)) out.add(p.id);
    } else out.add(token);
  }
  return [...out];
};

const lookup = (deps: RoleEditDeps, name: string): Role | string => {
  const key = name.trim().toLowerCase();
  if (key === OWNER_ROLE) return "`owner` is built in: it always holds everything and cannot be edited.";
  const role = deps.repo.book.get(key);
  return role ?? `There is no role called *${key}*. \`role list\` shows them.`;
};

export const createRole = (deps: RoleEditDeps, name: string, from?: string, description = ""): RoleResult<{ role: Role }> => {
  const bad = validRoleName(name);
  if (bad) return fail(bad);
  const key = name.trim().toLowerCase();
  if (deps.repo.book.get(key)) return fail(`There is already a role called *${key}*.`);
  let base: Role | undefined;
  if (from) {
    const found = lookup(deps, from);
    if (typeof found === "string") return fail(found);
    base = found;
  }
  const role: Role = {
    name: key,
    rank: base?.rank ?? 0,
    description: description || (base ? `Copied from ${base.name}.` : ""),
    enabled: true,
    // Copying is the owner's own decision, but the guard still reads: a role cannot grant what its editor lacks.
    grants: base ? base.grants.filter((g) => ungrantable(deps.repo.book, deps.editor, [g]).length === 0) : [],
    deniedTools: base?.deniedTools ?? [],
  };
  deps.repo.save(role, deps.by, deps.clock());
  return { ok: true, role };
};

const edit = (deps: RoleEditDeps, name: string, change: (r: Role) => Role | string): RoleResult<{ role: Role }> => {
  const found = lookup(deps, name);
  if (typeof found === "string") return fail(found);
  const next = change(found);
  if (typeof next === "string") return fail(next);
  deps.repo.save(next, deps.by, deps.clock());
  return { ok: true, role: next };
};

const checkPerms = (deps: RoleEditDeps, tokens: readonly string[]): { perms: string[] } | { error: string } => {
  const perms = expandPermissions(tokens, deps.catalogue);
  if (perms.length === 0) return { error: "Name at least one permission. `role show <role>` lists what exists." };
  const owner = perms.find(isOwnerOnlyPermission);
  if (owner) return { error: `\`${owner}\` is the owner's alone: managing roles can never be granted.` };
  const unknown = perms.filter((p) => !isKnownPermission(p, deps.catalogue));
  if (unknown.length > 0) return { error: `Not a permission I know: ${unknown.map((p) => `\`${p}\``).join(", ")}.` };
  const beyond = ungrantable(deps.repo.book, deps.editor, perms);
  if (beyond.length > 0) return { error: `You cannot grant what you do not hold: ${beyond.map((p) => `\`${p}\``).join(", ")}.` };
  return { perms };
};

export const grantPermissions = (deps: RoleEditDeps, name: string, tokens: readonly string[]): RoleResult<{ role: Role; added: string[] }> => {
  const checked = checkPerms(deps, tokens);
  if ("error" in checked) return fail(checked.error);
  let added: string[] = [];
  const done = edit(deps, name, (r) => {
    added = checked.perms.filter((p) => !r.grants.includes(p));
    return { ...r, grants: [...r.grants, ...added] };
  });
  return done.ok ? { ...done, added } : done;
};

export const revokePermissions = (deps: RoleEditDeps, name: string, tokens: readonly string[]): RoleResult<{ role: Role; removed: string[] }> => {
  // A revoke names ids that may no longer be in the catalogue (a removed command), so it is not held to it.
  const perms = expandPermissions(tokens, deps.catalogue);
  if (perms.length === 0) return fail("Name at least one permission. `role show <role>` lists what the role holds.");
  let removed: string[] = [];
  const done = edit(deps, name, (r) => {
    removed = perms.filter((p) => r.grants.includes(p));
    return { ...r, grants: r.grants.filter((g) => !perms.includes(g)) };
  });
  return done.ok ? { ...done, removed } : done;
};

export const describeRole = (deps: RoleEditDeps, name: string, description: string): RoleResult<{ role: Role }> =>
  edit(deps, name, (r) => ({ ...r, description: description.trim().slice(0, 300) }));

export const rankRole = (deps: RoleEditDeps, name: string, rank: number): RoleResult<{ role: Role }> => {
  if (!Number.isInteger(rank) || rank < 0 || rank > 10_000) return fail("A rank is a whole number from 0 up to 10000; higher outranks lower.");
  return edit(deps, name, (r) => ({ ...r, rank }));
};

export const switchRole = (deps: RoleEditDeps, name: string, enabled: boolean): RoleResult<{ role: Role }> =>
  edit(deps, name, (r) => ({ ...r, enabled }));

export const denyTools = (deps: RoleEditDeps, name: string, tools: readonly string[]): RoleResult<{ role: Role }> =>
  edit(deps, name, (r) => ({ ...r, deniedTools: [...new Set(tools.map((t) => t.trim()).filter(Boolean))] }));

/** Renaming moves everyone who holds the role in one transaction, so nobody is left on a name that no longer exists. */
export const renameRole = (deps: RoleEditDeps, from: string, to: string): RoleResult<{ role: Role }> => {
  const found = lookup(deps, from);
  if (typeof found === "string") return fail(found);
  const bad = validRoleName(to);
  if (bad) return fail(bad);
  const key = to.trim().toLowerCase();
  if (deps.repo.book.get(key)) return fail(`There is already a role called *${key}*.`);
  deps.repo.rename(found.name, key);
  if (deps.settings?.get(SETTING_KEYS.defaultRole)?.trim() === found.name) deps.settings.set(SETTING_KEYS.defaultRole, key);
  const moved = deps.settings?.get(`model:${found.name}`);
  if (moved !== undefined && moved !== "") {
    deps.settings?.set(`model:${key}`, moved);
    deps.settings?.set(`model:${found.name}`, "");
  }
  return { ok: true, role: { ...found, name: key } };
};

/**
 * Delete is refused while anybody holds the role - the people are named - rather
 * than guessing where they should go; move them first (`add @user <role>`). Nor can
 * the role approvals land on be deleted. Nothing else references a role by name.
 */
export const deleteRole = (
  deps: RoleEditDeps,
  name: string,
  holders: readonly { slackId: string }[],
): RoleResult<{ role: Role }> => {
  const found = lookup(deps, name);
  if (typeof found === "string") return fail(found);
  if (holders.length > 0) {
    const who = holders.slice(0, 8).map((u) => `<@${u.slackId}>`).join(", ");
    return fail(
      `${holders.length} ${holders.length === 1 ? "person holds" : "people hold"} *${found.name}* (${who}${holders.length > 8 ? ", ..." : ""}). Move them first with \`add @user <role>\`, then delete it.`,
    );
  }
  if (defaultRoleOf(deps.repo.book, deps.settings) === found.name) {
    return fail(`*${found.name}* is the role an approved access request gets. Set another with \`role default <role>\` first.`);
  }
  deps.repo.remove(found.name);
  return { ok: true, role: found };
};

export const setDefaultRole = (deps: RoleEditDeps, name: string): RoleResult<{ role: Role }> => {
  const found = lookup(deps, name);
  if (typeof found === "string") return fail(found);
  deps.settings?.set(SETTING_KEYS.defaultRole, found.name);
  return { ok: true, role: found };
};

/** MCP server names typed in by hand, kept in the catalogue so a role can be granted (or refused) them. */
export const addMcpServer = (settings: SettingsLike, server: string): RoleResult => {
  const s = server.trim().replace(/^mcp__/, "");
  if (!/^[A-Za-z0-9][\w.-]{0,99}$/.test(s)) return fail(`Not an MCP server name: ${server}`);
  const now = new Set(list(settings.get(SETTING_KEYS.roleMcpServers)));
  now.add(s);
  settings.set(SETTING_KEYS.roleMcpServers, [...now].sort().join(","));
  return { ok: true };
};

export { mcpServerTool };
