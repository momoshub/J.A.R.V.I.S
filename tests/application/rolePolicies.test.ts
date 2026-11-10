import { describe, expect, test } from "bun:test";
import { disabledRoleOf, enforceRolePolicies } from "../../src/application/rolePolicies.ts";
import { defaultRolePolicy, type RolePolicy } from "../../src/domain/rolePolicy.ts";
import type { UserRole } from "../../src/domain/types.ts";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createRolePolicyRepo } from "../../src/infrastructure/db/rolePolicyRepo.ts";
import { decideAccess } from "../../src/domain/access.ts";
import { toolPolicyFor } from "../../src/domain/toolPolicy.ts";
import { policyDisallow } from "../../src/domain/rolePolicy.ts";

const setup = () => {
  const db = openDatabase(":memory:");
  const store = createUserRepo(db);
  const policies = createRolePolicyRepo(db);
  for (const [slackId, role] of [["UOWNER", "owner"], ["UADMIN", "admin"], ["UPAL", "pal"]] as const) {
    store.upsert({ slackId, role, displayName: slackId, addedBy: "test", createdAt: 1 });
  }
  return { store, policies, users: enforceRolePolicies(store, policies.get) };
};

describe("role policies, persisted and enforced", () => {
  test("a role switched off in the DB is off the allowlist for every check, until switched back on", () => {
    const { store, policies, users } = setup();
    policies.save({ ...defaultRolePolicy("pal"), enabled: false }, "dashboard", 5);
    expect(users.get("UPAL")).toBeUndefined();
    expect(users.list().map((u) => u.slackId)).toEqual(["UOWNER", "UADMIN"]);
    expect(decideAccess("UPAL", "UOWNER", users.get).allowed).toBe(false);
    expect(disabledRoleOf(store, policies.get)("UPAL")).toBe("pal");
    expect(disabledRoleOf(store, policies.get)("UADMIN")).toBeUndefined();
    // The raw store still has them, so the dashboard can see and fix it.
    expect(store.get("UPAL")?.role).toBe("pal");
    policies.save({ ...defaultRolePolicy("pal"), enabled: true }, "dashboard", 6);
    expect(users.get("UPAL")?.role).toBe("pal");
  });

  test("the owner cannot be locked out, whatever row is stored", () => {
    const { policies, users } = setup();
    policies.save({ ...defaultRolePolicy("owner"), enabled: false, deniedTools: ["Bash"] }, "dashboard", 5);
    expect(users.get("UOWNER")?.role).toBe("owner");
    expect(decideAccess("UOWNER", "UOWNER", users.get).allowed).toBe(true);
    expect(policyDisallow(policies.get("owner"))).toEqual([]);
  });

  test("denied tools and MCP servers reach the CLI's --disallowedTools for that role", () => {
    const { policies } = setup();
    policies.save(
      { ...defaultRolePolicy("admin"), deniedTools: ["WebFetch"], deniedMcpServers: ["acme-pg-prod"] },
      "dashboard",
      5,
    );
    const policy = (role: UserRole) => toolPolicyFor(role, { roleDisallow: policyDisallow(policies.get(role)) });
    expect(policy("admin").disallowedTools).toContain("WebFetch");
    expect(policy("admin").disallowedTools).toContain("mcp__acme-pg-prod");
    expect(policy("admin").skipPermissions).toBe(true);
    expect(policy("pal").disallowedTools).not.toContain("WebFetch");
    // Unedited roles are exactly what they were.
    expect(policy("pal")).toEqual(toolPolicyFor("pal", {}));
  });

  test("the repo round-trips every field and reads unedited roles as defaults", () => {
    const { policies } = setup();
    const saved: RolePolicy = {
      role: "executer",
      enabled: false,
      deniedCommands: ["review"],
      deniedTools: ["Bash(rm:*)"],
      deniedMcpServers: ["notion"],
    };
    policies.save(saved, "dashboard", 5);
    expect(policies.get("executer")).toEqual(saved);
    expect(policies.get("pal")).toEqual(defaultRolePolicy("pal"));
    expect(policies.list().map((p) => p.role)).toEqual(["owner", "admin", "executer", "pal"]);
  });

  test("user rename refuses an id that is taken", () => {
    const { store } = setup();
    expect(store.rename("UPAL", "UADMIN")).toBe(false);
    expect(store.rename("UPAL", "UPAL2")).toBe(true);
    expect(store.get("UPAL2")?.role).toBe("pal");
    expect(store.get("UPAL")).toBeUndefined();
  });
});
