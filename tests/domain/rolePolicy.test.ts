import { describe, expect, test } from "bun:test";
import {
  defaultRolePolicy,
  disabledRoleReason,
  enforcedUser,
  isCommandDenied,
  isRoleEnabled,
  knownMcpServers,
  parseRolePolicy,
  policyDisallow,
  type RolePolicy,
} from "../../src/domain/rolePolicy.ts";
import type { AllowedUser, UserRole } from "../../src/domain/types.ts";

const user = (role: UserRole): AllowedUser => ({ slackId: "U1", role, displayName: "", addedBy: "x", createdAt: 0 });
const off = (role: UserRole): RolePolicy => ({ ...defaultRolePolicy(role), enabled: false });

describe("role policy", () => {
  test("a switched-off role grants nothing, but the owner role can never be switched off", () => {
    expect(isRoleEnabled(off("pal"))).toBe(false);
    expect(isRoleEnabled(off("owner"))).toBe(true);
    expect(enforcedUser(user("pal"), off)).toBeUndefined();
    expect(enforcedUser(user("owner"), off)?.role).toBe("owner");
    expect(enforcedUser(user("pal"), defaultRolePolicy)?.role).toBe("pal");
    expect(enforcedUser(undefined, defaultRolePolicy)).toBeUndefined();
  });

  test("denials apply to every role but the owner, and never to help", () => {
    const deny = (role: UserRole): RolePolicy => ({
      ...defaultRolePolicy(role),
      deniedCommands: ["ping", "help"],
      deniedTools: ["Bash"],
      deniedMcpServers: ["notion"],
    });
    expect(isCommandDenied(deny("admin"), "ping")).toBe(true);
    expect(isCommandDenied(deny("admin"), "help")).toBe(false);
    expect(isCommandDenied(deny("owner"), "ping")).toBe(false);
    expect(policyDisallow(deny("pal"))).toEqual(["Bash", "mcp__notion"]);
    expect(policyDisallow(deny("owner"))).toEqual([]);
  });

  test("parse checks names, normalises servers, refuses the owner and help", () => {
    const parse = (over: Record<string, unknown>) =>
      parseRolePolicy(
        { role: "executer", enabled: true, deniedCommands: [], deniedTools: [], deniedMcpServers: [], ...over },
        ["ping", "review", "help"],
      );
    expect(parse({ role: "owner" }).ok).toBe(false);
    expect(parse({ role: "god" }).ok).toBe(false);
    expect(parse({ deniedCommands: ["nope"] }).ok).toBe(false);
    expect(parse({ deniedCommands: ["help"] }).ok).toBe(false);
    expect(parse({ deniedTools: ["Bash; rm"] }).ok).toBe(false);
    expect(parse({ deniedMcpServers: ["bad server"] }).ok).toBe(false);
    expect(
      parse({
        enabled: false,
        deniedCommands: "Ping, review, ping",
        deniedTools: "Bash(rm:*)\nWrite",
        deniedMcpServers: ["mcp__pg-prod", "notion"],
      }),
    ).toEqual({
      ok: true,
      policy: {
        role: "executer",
        enabled: false,
        deniedCommands: ["ping", "review"],
        deniedTools: ["Bash(rm:*)", "Write"],
        deniedMcpServers: ["pg-prod", "notion"],
      },
    });
    // Anything but an explicit false keeps the role on.
    expect(parse({ enabled: undefined })).toMatchObject({ policy: { enabled: true } });
  });

  test("known MCP servers come from the code's lists and from what policies already deny", () => {
    const servers = knownMcpServers([{ ...defaultRolePolicy("pal"), deniedMcpServers: ["custom-db"] }]);
    expect(servers).toContain("pg-prod");
    expect(servers).toContain("claude_ai_Notion");
    expect(servers).toContain("custom-db");
    expect(servers).toEqual([...servers].sort());
  });

  test("the refusal names the role", () => {
    expect(disabledRoleReason("executer")).toContain("executer role is switched off");
  });
});
