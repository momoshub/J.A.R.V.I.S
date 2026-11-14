import { describe, expect, test } from "bun:test";
import { PERM, commandPerm, isOwnerOnlyPermission, permissionCatalogue } from "../../src/domain/permissions.ts";
import {
  OWNER_ROLE,
  can,
  highestRole,
  lowestRole,
  mayAssign,
  roleNamesWith,
  rolesWith,
  staticBook,
  ungrantable,
  validRoleName,
  type Role,
} from "../../src/domain/roles.ts";
import { builtinRoles } from "../../src/domain/roleSeed.ts";

const SEED = {
  commands: [{ name: "ping", minRole: "pal" }, { name: "watch", minRole: "executer" }, { name: "spend", minRole: "admin" }, { name: "role", minRole: "owner" }],
  dbServers: [],
  executerDbServers: [],
  extraMcpServers: [],
};
const role = (name: string, rank: number, grants: string[], over: Partial<Role> = {}): Role => ({
  name,
  rank,
  description: "",
  enabled: true,
  grants,
  deniedTools: [],
  ...over,
});
const book = staticBook(builtinRoles(SEED));

describe("the owner is the one hard-coded role", () => {
  test("it holds every permission without a row, and is always found", () => {
    expect(book.get(OWNER_ROLE)?.rank).toBeGreaterThan(1000);
    for (const p of [PERM.orca, commandPerm("anything"), "github:pr-merge", "mcp:whatever", "made:up"]) expect(can(book, OWNER_ROLE, p)).toBe(true);
  });

  test("a stored row can never replace it", () => {
    const sneaky = staticBook([role("owner", 0, [])]);
    expect(can(sneaky, OWNER_ROLE, PERM.orca)).toBe(true);
    expect(sneaky.get(OWNER_ROLE)?.grants).toEqual(["*"]);
  });

  test("managing roles is the owner's alone, whatever a stored row lists", () => {
    const hacked = staticBook([role("admin", 2, [commandPerm("role"), commandPerm("ping")])]);
    expect(isOwnerOnlyPermission(commandPerm("role"))).toBe(true);
    expect(can(hacked, "admin", commandPerm("role"))).toBe(false);
    expect(can(hacked, "admin", commandPerm("ping"))).toBe(true);
    expect(can(hacked, OWNER_ROLE, commandPerm("role"))).toBe(true);
    expect(permissionCatalogue({ commands: [{ name: "role", summary: "x" }, { name: "ping", summary: "y" }], mcpServers: [] }).map((p) => p.id)).not.toContain(commandPerm("role"));
  });
});

describe("can", () => {
  test("a role holds exactly its grants; an unknown or switched-off role holds nothing", () => {
    const b = staticBook([role("qa", 1, [commandPerm("ping")]), role("off", 1, [commandPerm("ping")], { enabled: false })]);
    expect(can(b, "qa", commandPerm("ping"))).toBe(true);
    expect(can(b, "qa", commandPerm("watch"))).toBe(false);
    expect(can(b, "off", commandPerm("ping"))).toBe(false);
    expect(can(b, "ghost", commandPerm("ping"))).toBe(false);
  });

  test("a refusal names who holds a permission, the owner only when nobody else does", () => {
    expect(roleNamesWith(book, commandPerm("watch"))).toBe("executer or admin");
    expect(roleNamesWith(book, commandPerm("spend"))).toBe("admin");
    expect(roleNamesWith(book, commandPerm("role"))).toBe("owner");
    expect(rolesWith(book, commandPerm("ping")).map((r) => r.name)).toEqual(["pal", "executer", "admin", "owner"]);
  });
});

describe("validRoleName", () => {
  test.each(["qa", "tier-2", "a_b", "x1"])("accepts %s", (n) => expect(validRoleName(n)).toBeUndefined());
  test.each(["", "Owner", "owner", "1abc", "has space", "a".repeat(33), "list", "grant", "delete"])("refuses %p", (n) => expect(validRoleName(n)).toBeDefined());
});

describe("the rank rule", () => {
  const b = staticBook([role("pal", 0, []), role("exec", 1, []), role("admin", 2, []), role("lead", 2, [])]);
  test("the owner may assign anything but owner", () => {
    expect(mayAssign(b, OWNER_ROLE, "admin", "pal")).toBeUndefined();
    expect(mayAssign(b, OWNER_ROLE, undefined, "admin")).toBeUndefined();
    expect(mayAssign(b, OWNER_ROLE, "pal", OWNER_ROLE)).toContain("one owner");
  });
  test("anyone else only touches roles strictly below their own", () => {
    expect(mayAssign(b, "admin", "pal", "exec")).toBeUndefined();
    expect(mayAssign(b, "admin", undefined, "pal")).toBeUndefined();
    expect(mayAssign(b, "admin", "pal", "admin")).toBeDefined(); // cannot hand out its own rank
    expect(mayAssign(b, "admin", "lead", "pal")).toBeDefined(); // nor change a peer
    expect(mayAssign(b, "admin", "pal", OWNER_ROLE)).toBeDefined();
    expect(mayAssign(b, "exec", "pal", "pal")).toBeUndefined();
    expect(mayAssign(b, "pal", "pal", "pal")).toBeDefined();
    expect(mayAssign(b, "ghost", undefined, "pal")).toBeDefined();
  });
});

describe("a role cannot grant what its editor does not hold", () => {
  test("the owner holds everything; a smaller editor is held to its own grants", () => {
    const b = staticBook([role("qa", 1, [commandPerm("ping")])]);
    expect(ungrantable(b, OWNER_ROLE, [PERM.orca, commandPerm("watch")])).toEqual([]);
    expect(ungrantable(b, "qa", [commandPerm("ping"), commandPerm("watch")])).toEqual([commandPerm("watch")]);
  });
});

describe("lowest and highest role", () => {
  test("by rank, then by how much is granted, so a copy of pal never displaces pal", () => {
    const b = staticBook([...builtinRoles(SEED), role("qa", 0, builtinRoles(SEED)[0]!.grants as string[])]);
    expect(lowestRole(b)?.name).toBe("pal");
    expect(highestRole(b)?.name).toBe("admin");
    // a role with fewer grants at the same rank is the more cautious default
    const cautious = staticBook([...builtinRoles(SEED), role("guest", 0, [])]);
    expect(lowestRole(cautious)?.name).toBe("guest");
    expect(lowestRole(staticBook([]))).toBeUndefined();
    expect(lowestRole(staticBook([role("off", 0, [], { enabled: false })]))).toBeUndefined();
  });
});
