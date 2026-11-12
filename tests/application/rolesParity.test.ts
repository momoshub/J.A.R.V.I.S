import { describe, expect, test } from "bun:test";
import { COMMANDS, listCommandInfo } from "../../src/application/commands.ts";
import { seedRoles } from "../../src/application/roles.ts";
import { ACTIONS, mayActAsApp, permissionFor } from "../../src/domain/githubAppAction.ts";
import { GITHUB_PERMISSION_ACTIONS, PERM, commandPerm, githubPerm, mcpPerm } from "../../src/domain/permissions.ts";
import { can } from "../../src/domain/roles.ts";
import { seededBook } from "../../src/domain/roleSeed.ts";
import { toolPolicyFor, mayUseOrca, mayUseNotion } from "../../src/domain/toolPolicy.ts";
import { cloudwatchMode } from "../../src/domain/cloudwatch.ts";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createRoleRepo } from "../../src/infrastructure/db/roleRepo.ts";
import { readLegacyPolicies } from "../../src/infrastructure/db/rolePolicyRepo.ts";
import { createSettingsRepo, SETTING_KEYS } from "../../src/infrastructure/db/settingsRepo.ts";

/** What the code did before roles were data: pal < executer < admin < owner, a command's minRole the whole rule. */
const OLD_RANK: Record<string, number> = { pal: 0, executer: 1, admin: 2, owner: 3 };
const ROLES = ["pal", "executer", "admin", "owner"] as const;
const DB = ["db-prod", "db-ro"];
const EXEC_DB = ["db-ro"];
const SEED = {
  commands: listCommandInfo().map((c) => ({ name: c.name, minRole: c.minRole })),
  dbServers: DB,
  executerDbServers: EXEC_DB,
  extraMcpServers: [] as string[],
};

const stored = (setup?: (db: ReturnType<typeof openDatabase>) => void) => {
  const db = openDatabase(":memory:");
  setup?.(db);
  const settings = createSettingsRepo(db);
  const repo = createRoleRepo(db);
  seedRoles({ repo, settings, clock: () => 1, legacyPolicies: () => readLegacyPolicies(db), input: () => SEED });
  return { db, settings, repo, book: repo.book };
};

describe("parity: the seeded roles behave exactly as the hard-coded ones did", () => {
  const { book } = stored();

  test("every command: a role may run it exactly when its rank reached the command's minRole", () => {
    // `note` and `read` were gated by a settings floor (default admin), not by minRole: their minRole is now that default.
    for (const c of COMMANDS) {
      for (const role of ROLES) {
        const old = OLD_RANK[role]! >= OLD_RANK[c.minRole]!;
        expect({ command: c.name, role, can: can(book, role, commandPerm(c.name)) }).toEqual({ command: c.name, role, can: old });
      }
    }
  });

  test("every GitHub App action: admin and owner may, executer and pal may not", () => {
    for (const a of ACTIONS) {
      if (a === "ticket-renew") continue;
      for (const role of ROLES) {
        const perm = permissionFor(a, "git")!;
        expect({ a, role, can: can(book, role, perm) }).toEqual({ a, role, can: role === "admin" || role === "owner" });
      }
    }
    for (const a of GITHUB_PERMISSION_ACTIONS) {
      expect(can(book, "executer", githubPerm(a))).toBe(false);
      expect(can(book, "admin", githubPerm(a))).toBe(true);
    }
    for (const role of ROLES) expect(mayActAsApp(book, role)).toBe(role === "admin" || role === "owner");
  });

  test("worker tickets are minted by admin and owner (command:worker-ticket)", () => {
    for (const role of ROLES) expect(can(book, role, commandPerm("worker-ticket"))).toBe(role === "admin" || role === "owner");
  });

  test("tool tiers: owner/admin full access, executer code tools, pal read only; Orca owner only", () => {
    const opts = { roles: book, dbServers: DB, executerDbServers: EXEC_DB, fullCwd: "/f", sandboxCwd: "/s" };
    expect(toolPolicyFor("owner", opts).skipPermissions).toBe(true);
    expect(toolPolicyFor("admin", opts).skipPermissions).toBe(true);
    expect(toolPolicyFor("executer", opts).skipPermissions).toBe(false);
    expect(toolPolicyFor("pal", opts).skipPermissions).toBe(false);
    expect(toolPolicyFor("executer", opts).allowedTools).toContain("Bash(git push:*)");
    expect(toolPolicyFor("pal", opts).allowedTools).not.toContain("Bash(git push:*)");
    for (const role of ROLES) expect(mayUseOrca(role, book)).toBe(role === "owner");
    expect(toolPolicyFor("admin", opts).disallowedTools).toContain("Bash(orca:*)");
    expect(toolPolicyFor("owner", opts).disallowedTools).not.toContain("Bash(orca:*)");
  });

  test("MCP servers: databases for full access, the read-only one for an executer, notion for admin and owner, datadog for all", () => {
    for (const role of ROLES) {
      expect(can(book, role, mcpPerm("datadog"))).toBe(true);
      expect(mayUseNotion(role, book)).toBe(role === "admin" || role === "owner");
      expect(can(book, role, mcpPerm("db-prod"))).toBe(role === "admin" || role === "owner");
      expect(can(book, role, mcpPerm("db-ro"))).toBe(role !== "pal");
    }
    const opts = { roles: book, dbServers: DB, executerDbServers: EXEC_DB };
    expect(toolPolicyFor("pal", opts).disallowedTools).toEqual(expect.arrayContaining(["mcp__db-prod", "mcp__db-ro", "mcp__notion"]));
    expect(toolPolicyFor("executer", opts).disallowedTools).toContain("mcp__db-prod");
    expect(toolPolicyFor("executer", opts).disallowedTools).not.toContain("mcp__db-ro");
    expect(toolPolicyFor("admin", opts).disallowedTools).not.toContain("mcp__db-prod");
  });

  test("the guarded sub-actions and per-role behaviours that were `role >= x` checks", () => {
    const held = (role: string) => [
      PERM.selfUpdate, PERM.desktop, PERM.unlimited, PERM.approveCommands, PERM.decideAccess, PERM.manageSettings,
      PERM.reviewPolicy, PERM.stopAny, PERM.twoFa, PERM.shellWatch, PERM.manageReminders, PERM.cloudwatchDirect, PERM.orca,
    ].filter((p) => can(book, role, p));
    expect(held("pal")).toEqual([]);
    expect(held("executer").sort()).toEqual([PERM.desktop, PERM.unlimited, PERM.reviewPolicy, PERM.shellWatch].sort());
    expect(held("admin").sort()).toEqual(
      [PERM.selfUpdate, PERM.desktop, PERM.unlimited, PERM.approveCommands, PERM.decideAccess, PERM.manageSettings,
        PERM.reviewPolicy, PERM.stopAny, PERM.twoFa, PERM.shellWatch, PERM.manageReminders].sort(),
    );
    expect(held("owner").length).toBe(13);
    // cloudwatch: owner direct, admin and executer confirm, pal refused
    expect(["pal", "executer", "admin", "owner"].map((r) => cloudwatchMode(r, book))).toEqual(["refuse", "confirm", "confirm", "run"]);
  });

  test("the same defaults come out of a book with no database behind it", () => {
    const bare = seededBook(SEED);
    for (const c of COMMANDS) for (const role of ROLES) expect(can(bare, role, commandPerm(c.name))).toBe(can(book, role, commandPerm(c.name)));
  });
});

describe("migration: existing deny policies and floors keep working with zero behaviour change", () => {
  const withLegacy = (db: ReturnType<typeof openDatabase>) => {
    db.query(
      "INSERT INTO role_policies (role, enabled, denied_commands, denied_tools, denied_mcp_servers) VALUES (?, ?, ?, ?, ?)",
    ).run("executer", 1, JSON.stringify(["watch", "review"]), JSON.stringify(["Bash(rm:*)"]), JSON.stringify(["db-ro", "legacy-server"]));
    db.query("INSERT INTO role_policies (role, enabled) VALUES (?, ?)").run("pal", 0);
    // the old floors: note open to executer and up, read left at its default
    createSettingsRepo(db).set(SETTING_KEYS.noteMinRole, "executer");
  };

  test("denied commands, tools and servers become missing grants and a denied tool list; off stays off", () => {
    const { book, repo } = stored(withLegacy);
    expect(can(book, "executer", commandPerm("watch"))).toBe(false);
    // `review` was renamed quick-review: the stored denial follows it
    expect(can(book, "executer", commandPerm("quick-review"))).toBe(false);
    expect(can(book, "executer", commandPerm("ping"))).toBe(true);
    expect(can(book, "executer", commandPerm("workflow"))).toBe(true);
    expect(repo.book.get("executer")?.deniedTools).toEqual(["Bash(rm:*)"]);
    expect(can(book, "executer", mcpPerm("db-ro"))).toBe(false);
    expect(can(book, "executer", mcpPerm("legacy-server"))).toBe(false);
    // a server a policy denied that the host does not list stays a known server, so admin keeps it
    expect(can(book, "admin", mcpPerm("legacy-server"))).toBe(true);
    expect(repo.book.get("pal")?.enabled).toBe(false);
    expect(repo.book.get("admin")?.enabled).toBe(true);
    // the tool list reaches the CLI as it did
    const policy = toolPolicyFor("executer", { roles: book, dbServers: DB, executerDbServers: EXEC_DB, extraMcpServers: ["legacy-server"] });
    expect(policy.disallowedTools).toEqual(expect.arrayContaining(["Bash(rm:*)", "mcp__db-ro", "mcp__legacy-server"]));
  });

  test("the note floor setting becomes who holds command:note and the Notion server", () => {
    const { book } = stored(withLegacy);
    expect(can(book, "pal", commandPerm("note"))).toBe(false);
    expect(can(book, "executer", commandPerm("note"))).toBe(true);
    expect(can(book, "admin", commandPerm("note"))).toBe(true);
    expect(can(book, "executer", mcpPerm("notion"))).toBe(true);
    expect(can(book, "pal", mcpPerm("notion"))).toBe(false);
    // read had no floor set: admin and up, as before
    expect(can(book, "executer", commandPerm("read"))).toBe(false);
    expect(can(book, "admin", commandPerm("read"))).toBe(true);
  });

  test("seeding is idempotent, a revoke sticks, and a later permission reaches only the built-ins", () => {
    const { db, settings, repo } = stored();
    const edit = repo.book.get("executer")!;
    repo.save({ ...edit, grants: edit.grants.filter((g) => g !== commandPerm("ping")) }, "owner", 2);
    repo.save({ name: "qa", rank: 1, description: "", enabled: true, grants: [commandPerm("ping")], deniedTools: [] }, "owner", 2);
    const again = (commands: typeof SEED.commands) =>
      seedRoles({ repo, settings, clock: () => 3, legacyPolicies: () => readLegacyPolicies(db), input: () => ({ ...SEED, commands }) });
    again(SEED.commands);
    expect(can(repo.book, "executer", commandPerm("ping"))).toBe(false); // the revoke held
    // a command added by a later release
    again([...SEED.commands, { name: "brand-new", minRole: "executer" }]);
    expect(can(repo.book, "executer", commandPerm("brand-new"))).toBe(true);
    expect(can(repo.book, "pal", commandPerm("brand-new"))).toBe(false);
    expect(can(repo.book, "admin", commandPerm("brand-new"))).toBe(true);
    expect(can(repo.book, "qa", commandPerm("brand-new"))).toBe(false); // a custom role is never widened behind its owner's back
  });
});
