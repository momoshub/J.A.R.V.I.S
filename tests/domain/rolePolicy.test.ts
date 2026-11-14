import { describe, expect, test } from "bun:test";
import { CORE_TOOLS, UNDENIABLE_COMMANDS, currentCommandName, disabledRoleReason, enforcedUser, isRoleEnabled, mcpServerTool, parseDeniedTools, roleNames } from "../../src/domain/rolePolicy.ts";
import { staticBook } from "../../src/domain/roles.ts";
import { builtinRoles } from "../../src/domain/roleSeed.ts";
import type { AllowedUser } from "../../src/domain/types.ts";

const book = staticBook(builtinRoles({ commands: [], dbServers: [], executerDbServers: [], extraMcpServers: [] }));
const off = staticBook(builtinRoles({ commands: [], dbServers: [], executerDbServers: [], extraMcpServers: [] }).map((r) => (r.name === "admin" ? { ...r, enabled: false } : r)));
const user = (role: string): AllowedUser => ({ slackId: "U1", role, displayName: "", addedBy: "x", createdAt: 1 });

describe("a switched-off role", () => {
  test("is off the allowlist, the owner never is, and a deleted role grants nothing", () => {
    expect(enforcedUser(user("admin"), book)).toBeDefined();
    expect(enforcedUser(user("admin"), off)).toBeUndefined();
    expect(enforcedUser(user("owner"), off)).toBeDefined();
    expect(enforcedUser(user("gone"), book)).toBeUndefined();
    expect(enforcedUser(undefined, book)).toBeUndefined();
    expect(isRoleEnabled(off, "admin")).toBe(false);
    expect(isRoleEnabled(off, "owner")).toBe(true);
  });

  test("the reason names the role", () => {
    expect(disabledRoleReason("qa")).toContain("qa role is switched off");
  });
});

describe("what surrounds a role record", () => {
  test("roles list highest rank first, the owner on top", () => {
    expect(roleNames(book)).toEqual(["owner", "admin", "executer", "pal"]);
  });

  test("help cannot be denied, and a server name maps to its mcp__ tool", () => {
    expect(UNDENIABLE_COMMANDS).toContain("help");
    expect(mcpServerTool("notion")).toBe("mcp__notion");
    expect(mcpServerTool("mcp__notion")).toBe("mcp__notion");
    expect(CORE_TOOLS).toContain("Bash");
  });

  test("a denied tool list is checked, comma or line separated, de-duplicated", () => {
    expect(parseDeniedTools("Bash(rm:*), WebFetch\nWebFetch")).toEqual({ ok: true, tools: ["Bash(rm:*)", "WebFetch"] });
    expect(parseDeniedTools(["Read"])).toEqual({ ok: true, tools: ["Read"] });
    expect(parseDeniedTools("")).toEqual({ ok: true, tools: [] });
    expect(parseDeniedTools("rm -rf /").ok).toBe(false);
  });

  test("a stored command name follows a rename; approve maps to nothing", () => {
    expect(currentCommandName("review")).toBe("quick-review");
    expect(currentCommandName(" PING ")).toBe("ping");
    expect(currentCommandName("approve")).toBeUndefined();
  });
});
