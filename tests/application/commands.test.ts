import { describe, expect, test } from "bun:test";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import {
  executeCommand,
  parseCommand,
  type CommandDeps,
} from "../../src/application/commands.ts";
import type { AllowedUser } from "../../src/domain/types.ts";

const OWNER = "U0OWNER0001";

describe("parseCommand", () => {
  test("returns undefined for plain chat", () => {
    expect(parseCommand("hey what's up")).toBeUndefined();
  });

  test("parses help and whoami", () => {
    expect(parseCommand("!help")).toEqual({ kind: "help" });
    expect(parseCommand("!whoami")).toEqual({ kind: "whoami" });
  });

  test("parses add with a mention and role", () => {
    expect(parseCommand("!add <@U123> admin")).toEqual({
      kind: "addUser",
      slackId: "U123",
      role: "admin",
    });
  });

  test("add defaults to member and handles piped mentions", () => {
    expect(parseCommand("!add <@U123|kai>")).toEqual({
      kind: "addUser",
      slackId: "U123",
      role: "member",
    });
  });

  test("promote and demote map to roles", () => {
    expect(parseCommand("!promote <@U9>")).toEqual({
      kind: "setRole",
      slackId: "U9",
      role: "admin",
    });
    expect(parseCommand("!demote <@U9>")).toEqual({
      kind: "setRole",
      slackId: "U9",
      role: "member",
    });
  });

  test("add without a target is unknown", () => {
    expect(parseCommand("!add")).toEqual({ kind: "unknown", input: "!add" });
  });
});

let db: DbClient;
const actor = (over: Partial<AllowedUser> = {}): AllowedUser => ({
  slackId: OWNER,
  role: "owner",
  displayName: "Kai",
  addedBy: "system",
  createdAt: 0,
  ...over,
});

const build = (): CommandDeps => {
  db = openDatabase(":memory:");
  return {
    users: createUserRepo(db),
    messages: createMessageRepo(db),
    clock: () => 42,
    ownerSlackId: OWNER,
  };
};

describe("executeCommand", () => {
  test("owner can add an admin", () => {
    const deps = build();
    const out = executeCommand(deps, actor(), { kind: "addUser", slackId: "U1", role: "admin" }, "C1");
    expect(out).toContain("admin");
    expect(deps.users.get("U1")?.role).toBe("admin");
  });

  test("admin cannot add an admin", () => {
    const deps = build();
    const admin = actor({ slackId: "U2", role: "admin" });
    const out = executeCommand(deps, admin, { kind: "addUser", slackId: "U1", role: "admin" }, "C1");
    expect(out).toContain("Only the owner");
    expect(deps.users.get("U1")).toBeUndefined();
  });

  test("admin can add a member", () => {
    const deps = build();
    const admin = actor({ slackId: "U2", role: "admin" });
    executeCommand(deps, admin, { kind: "addUser", slackId: "U1", role: "member" }, "C1");
    expect(deps.users.get("U1")?.role).toBe("member");
  });

  test("owner cannot be removed", () => {
    const deps = build();
    deps.users.upsert(actor());
    const out = executeCommand(deps, actor(), { kind: "removeUser", slackId: OWNER }, "C1");
    expect(out).toContain("cannot be removed");
    expect(deps.users.get(OWNER)).toBeDefined();
  });

  test("member cannot list users", () => {
    const deps = build();
    const member = actor({ slackId: "U3", role: "member" });
    expect(executeCommand(deps, member, { kind: "listUsers" }, "C1")).toContain("Only admins");
  });

  test("forget clears channel memory", () => {
    const deps = build();
    deps.messages.append({ channelId: "C1", slackUserId: OWNER, role: "user", content: "x" }, 1);
    const out = executeCommand(deps, actor(), { kind: "forget" }, "C1");
    expect(out).toContain("Wiped 1");
    expect(deps.messages.recentForChannel("C1", 10)).toHaveLength(0);
  });
});
