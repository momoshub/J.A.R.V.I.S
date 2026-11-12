import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disabledRoleOf, enforceRolePolicies } from "../../src/application/rolePolicies.ts";
import { decideAccess } from "../../src/domain/access.ts";
import { toolPolicyFor } from "../../src/domain/toolPolicy.ts";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createRoleRepo } from "../../src/infrastructure/db/roleRepo.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { builtinRoles } from "../../src/domain/roleSeed.ts";

const SEED = { commands: [{ name: "ping", minRole: "pal" }], dbServers: [], executerDbServers: [], extraMcpServers: [] };

const setup = () => {
  const db = openDatabase(":memory:");
  const store = createUserRepo(db);
  const roles = createRoleRepo(db);
  for (const r of builtinRoles(SEED)) roles.save(r, "test", 1);
  for (const [slackId, role] of [["UOWNER", "owner"], ["UADMIN", "admin"], ["UPAL", "pal"]] as const) {
    store.upsert({ slackId, role, displayName: slackId, addedBy: "test", createdAt: 1 });
  }
  return { db, store, roles, users: enforceRolePolicies(store, roles.book) };
};

describe("roles, persisted and enforced", () => {
  test("a role switched off in the DB is off the allowlist for every check, until switched back on", () => {
    const { store, roles, users } = setup();
    roles.save({ ...roles.book.get("pal")!, enabled: false }, "dashboard", 5);
    expect(users.get("UPAL")).toBeUndefined();
    expect(users.list().map((u) => u.slackId)).toEqual(["UOWNER", "UADMIN"]);
    expect(decideAccess("UPAL", "UOWNER", users.get).allowed).toBe(false);
    expect(disabledRoleOf(store, roles.book)("UPAL")).toBe("pal");
    expect(disabledRoleOf(store, roles.book)("UADMIN")).toBeUndefined();
    // The raw store still has them, so the dashboard can see and fix it.
    expect(store.get("UPAL")?.role).toBe("pal");
    roles.save({ ...roles.book.get("pal")!, enabled: true }, "dashboard", 6);
    expect(users.get("UPAL")?.role).toBe("pal");
  });

  test("the owner cannot be locked out, whatever is stored under that name", () => {
    const { roles, users } = setup();
    roles.save({ name: "owner", rank: 0, description: "", enabled: false, grants: [], deniedTools: ["Bash"] }, "dashboard", 5);
    expect(users.get("UOWNER")?.role).toBe("owner");
    expect(decideAccess("UOWNER", "UOWNER", users.get).allowed).toBe(true);
    expect(toolPolicyFor("owner", { roles: roles.book }).skipPermissions).toBe(true);
    expect(toolPolicyFor("owner", { roles: roles.book }).disallowedTools).not.toContain("Bash");
  });

  test("a role's denied tools and missing MCP grants reach the CLI's --disallowedTools for that role only", () => {
    const { roles } = setup();
    const admin = roles.book.get("admin")!;
    roles.save({ ...admin, deniedTools: ["WebFetch"], grants: admin.grants.filter((g) => g !== "mcp:acme-pg-prod") }, "dashboard", 5);
    const opts = { roles: roles.book, dbServers: ["acme-pg-prod"] };
    expect(toolPolicyFor("admin", opts).disallowedTools).toContain("WebFetch");
    expect(toolPolicyFor("admin", opts).disallowedTools).toContain("mcp__acme-pg-prod");
    expect(toolPolicyFor("admin", opts).skipPermissions).toBe(true);
    expect(toolPolicyFor("pal", opts).disallowedTools).not.toContain("WebFetch");
  });

  test("the repo round-trips every field, reads a write at once, and renames atomically", () => {
    const { roles, store } = setup();
    const saved = { name: "qa", rank: 1, description: "tests", enabled: false, grants: ["command:ping", "github:comment"], deniedTools: ["Bash(rm:*)"], seed: undefined };
    roles.save(saved, "dashboard", 5);
    expect(roles.book.get("qa")).toEqual({ name: "qa", rank: 1, description: "tests", enabled: false, grants: ["command:ping", "github:comment"], deniedTools: ["Bash(rm:*)"] });
    expect(roles.book.list().map((r) => r.name)).toEqual(["owner", "admin", "executer", "qa", "pal"]);
    expect(roles.stored().map((r) => r.name)).not.toContain("owner");
    store.upsert({ slackId: "UQA", role: "qa", displayName: "", addedBy: "x", createdAt: 1 });
    expect(roles.holders("qa")).toBe(1);
    roles.rename("qa", "testers");
    expect(roles.book.get("qa")).toBeUndefined();
    expect(roles.book.get("testers")?.grants).toEqual(["command:ping", "github:comment"]);
    expect(store.get("UQA")?.role).toBe("testers");
    roles.remove("testers");
    expect(roles.book.get("testers")).toBeUndefined();
  });

  test("a write from another connection (a script, another process) is seen without a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "roles-"));
    try {
      const path = join(dir, "bot.db");
      const mine = openDatabase(path);
      const roles = createRoleRepo(mine);
      expect(roles.book.get("late")).toBeUndefined();
      const other = openDatabase(path);
      other.query("INSERT INTO roles (name, rank, grants) VALUES ('late', 3, '[\"command:ping\"]')").run();
      expect(roles.book.get("late")?.grants).toEqual(["command:ping"]);
      other.close();
      mine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("user rename refuses an id that is taken", () => {
    const { store } = setup();
    expect(store.rename("UPAL", "UADMIN")).toBe(false);
    expect(store.rename("UPAL", "UPAL2")).toBe(true);
    expect(store.get("UPAL2")?.role).toBe("pal");
  });
});
