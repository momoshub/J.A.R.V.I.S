/**
 * The roles seeded on first boot, and what each grants by default.
 *
 * `pal`, `executer` and `admin` are ordinary data once seeded: the grants below
 * only decide where they START, and are chosen to reproduce what the code did
 * before roles became data (a command's `minRole`, the sandbox tiers, the GitHub
 * App gate, every `role >= admin` check). `tests/application/rolesParity.test.ts` holds
 * that parity for every command and GitHub App action.
 *
 * A permission added later (a new command, a new MCP server) is seeded into the
 * built-in roles the same way - by `seedMissing` - but never into a custom role.
 */
import { GITHUB_PERMISSION_ACTIONS, PERM, commandPerm, githubPerm, mcpPerm } from "./permissions.ts";
import { staticBook, type Role, type RoleBook } from "./roles.ts";

export const BUILTIN_RANK: Readonly<Record<string, number>> = { pal: 0, executer: 1, admin: 2 };

const DESCRIPTION: Readonly<Record<string, string>> = {
  pal: "Sandboxed, read-only tools in a fixed scratch directory. Limited command allowance.",
  executer: "Sandboxed, plus code edits, commits, pushing a branch and opening a PR, subagents, browser tests.",
  admin: "Sandboxed like an executer (code tools, the read-only databases, Notion), plus the configuration commands and managing users. Cannot start Orca workers or manage roles.",
};

export type SeedInput = {
  /** Every command with its default minimum role (`pal` | `executer` | `admin` | `owner`). */
  readonly commands: readonly { readonly name: string; readonly minRole: string }[];
  /** Local database MCP servers on the host (`DB_MCP_SERVERS`). */
  readonly dbServers: readonly string[];
  /** The subset an executer may query (`EXECUTER_DB_MCP_SERVERS`). */
  readonly executerDbServers: readonly string[];
  /** Other MCP servers the host knows (a server a stored policy denied, typed in by hand). */
  readonly extraMcpServers: readonly string[];
  /**
   * Where `note` and `read` started: the lowest built-in role they were open to
   * (`note_min_role` / `read_min_role` before they became grants), default `admin`.
   * `note`'s floor also decides the Notion MCP server.
   */
  readonly floors?: { readonly note?: string; readonly read?: string };
};

export const NOTION_SERVER = "notion";
export const DATADOG_SERVER = "datadog";

/** MCP servers a role can be granted: the host's databases, notion, datadog and any named by hand. */
export const mcpCatalogue = (input: Pick<SeedInput, "dbServers" | "extraMcpServers">): readonly string[] => [
  ...new Set(
    [NOTION_SERVER, DATADOG_SERVER, ...input.dbServers, ...input.extraMcpServers]
      .map((s) => s.trim().replace(/^mcp__/, ""))
      .filter(Boolean),
  ),
];

const COMMAND_RANK: Readonly<Record<string, number>> = { pal: 0, executer: 1, admin: 2, owner: 3 };

/** The role a command is seeded open to: its `minRole`, except `note` and `read`, whose floor was a setting. */
const seedMinRole = (c: SeedInput["commands"][number], input: SeedInput): string =>
  c.name === "note" ? (input.floors?.note ?? "admin") : c.name === "read" ? (input.floors?.read ?? "admin") : c.minRole;

const EXECUTER_GITHUB = ["git", "pr-create", "pr-edit", "comment", "labels-add", "reviewers-request"] as const;

const GITHUB_ALL = GITHUB_PERMISSION_ACTIONS.map(githubPerm);

/** What a built-in role grants by default. */
export const defaultGrants = (seed: string, input: SeedInput): readonly string[] => {
  const rank = BUILTIN_RANK[seed] ?? 0;
  const commands = input.commands
    .filter((c) => (COMMAND_RANK[seedMinRole(c, input)] ?? 3) <= rank)
    .map((c) => commandPerm(c.name));
  const executerDb = new Set(input.executerDbServers.map((s) => s.replace(/^mcp__/, "")));
  const servers = mcpCatalogue({ dbServers: [...input.dbServers, ...input.executerDbServers], extraMcpServers: input.extraMcpServers });
  const mcp = servers.filter((s) => {
    if (s === DATADOG_SERVER) return true;
    // Notion writes as the host: the `note` floor (admin) - see `note_min_role` in the migration.
    if (s === NOTION_SERVER) return rank >= (COMMAND_RANK[input.floors?.note ?? "admin"] ?? 3);
    // Only the owner has full access, so a database server is the read-only subset an executer (and admin) may query.
    return rank >= BUILTIN_RANK.executer! && executerDb.has(s);
  });
  const grants: string[] = [...commands, ...mcp.map(mcpPerm)];
  if (rank >= BUILTIN_RANK.executer!) grants.push(PERM.code, PERM.shellWatch, PERM.unlimited, PERM.desktop);
  // An executer acts as the app for commits (identity only: no `github:push`, so no token), PRs, comments, labels and reviewer requests.
  if (rank === BUILTIN_RANK.executer!) grants.push(...EXECUTER_GITHUB.map(githubPerm));
  if (rank >= BUILTIN_RANK.admin!) {
    // Admin stays on the `code` sandbox tier like an executer: `tools:full-access` is the owner's alone.
    grants.push(
      PERM.selfUpdate, PERM.approveCommands, PERM.decideAccess, PERM.manageSettings,
      PERM.reviewPolicy, PERM.stopAny, PERM.twoFa, PERM.manageReminders, ...GITHUB_ALL,
    );
  }
  // An executer picks its own policy; a pal never does (`palOnly` in quick-review).
  if (rank >= BUILTIN_RANK.executer!) grants.push(PERM.reviewPolicy);
  return [...new Set(grants)];
};

/** The three built-in roles as they are seeded. */
export const builtinRoles = (input: SeedInput): readonly Role[] =>
  Object.keys(BUILTIN_RANK).map((seed) => ({
    name: seed,
    seed,
    rank: BUILTIN_RANK[seed]!,
    description: DESCRIPTION[seed] ?? "",
    enabled: true,
    grants: defaultGrants(seed, input),
    deniedTools: [],
  }));

const NO_COMMANDS: SeedInput = { commands: [], dbServers: [], executerDbServers: [], extraMcpServers: [] };

/**
 * The built-in roles as a book, for a caller that has no database behind it (a
 * test, or a surface wired without one). Command grants need the registry, so
 * pass `commands` when the book must answer for them.
 */
export const seededBook = (input: Partial<SeedInput> = {}): RoleBook => staticBook(builtinRoles({ ...NO_COMMANDS, ...input }));
