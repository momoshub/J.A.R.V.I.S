import { describe, expect, test } from "bun:test";
import {
  canManageAdmins,
  canManageUsers,
  decideAccess,
  validateRemoval,
  validateRoleChange,
} from "../../src/domain/access.ts";
import type { AllowedUser } from "../../src/domain/types.ts";

const OWNER = "U0OWNER0001";

const makeUser = (over: Partial<AllowedUser> = {}): AllowedUser => ({
  slackId: "U1",
  role: "member",
  displayName: "Test",
  addedBy: "system",
  createdAt: 0,
  ...over,
});

describe("role capabilities", () => {
  test("owner and admin can manage users, member cannot", () => {
    expect(canManageUsers("owner")).toBe(true);
    expect(canManageUsers("admin")).toBe(true);
    expect(canManageUsers("member")).toBe(false);
  });

  test("only owner can manage admins", () => {
    expect(canManageAdmins("owner")).toBe(true);
    expect(canManageAdmins("admin")).toBe(false);
    expect(canManageAdmins("member")).toBe(false);
  });
});

describe("decideAccess", () => {
  test("allows a user present on the allowlist", () => {
    const user = makeUser({ slackId: "U1", role: "member" });
    const decision = decideAccess("U1", OWNER, () => user);
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.user).toEqual(user);
  });

  test("allows the owner even when missing from the allowlist", () => {
    const decision = decideAccess(OWNER, OWNER, () => undefined);
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.user.role).toBe("owner");
  });

  test("denies an unknown user", () => {
    const decision = decideAccess("Ustranger", OWNER, () => undefined);
    expect(decision.allowed).toBe(false);
  });
});

describe("validateRoleChange", () => {
  test("owner's role can never change", () => {
    expect(validateRoleChange("owner", "owner", "admin", true)).toBeDefined();
  });

  test("member cannot manage users", () => {
    expect(validateRoleChange("member", "member", "admin", false)).toBeDefined();
  });

  test("admin cannot touch admin roles", () => {
    expect(validateRoleChange("admin", "member", "admin", false)).toBeDefined();
    expect(validateRoleChange("admin", "admin", "member", false)).toBeDefined();
  });

  test("owner can promote a member to admin", () => {
    expect(validateRoleChange("owner", "member", "admin", false)).toBeUndefined();
  });

  test("nobody can mint a second owner", () => {
    expect(validateRoleChange("owner", "member", "owner", false)).toBeDefined();
  });

  test("admin can add a plain member", () => {
    expect(validateRoleChange("admin", "member", "member", false)).toBeUndefined();
  });
});

describe("validateRemoval", () => {
  test("owner cannot be removed", () => {
    expect(validateRemoval("owner", "owner", true)).toBeDefined();
  });

  test("member cannot remove anyone", () => {
    expect(validateRemoval("member", "member", false)).toBeDefined();
  });

  test("admin cannot remove another admin", () => {
    expect(validateRemoval("admin", "admin", false)).toBeDefined();
  });

  test("owner can remove an admin", () => {
    expect(validateRemoval("owner", "admin", false)).toBeUndefined();
  });

  test("admin can remove a member", () => {
    expect(validateRemoval("admin", "member", false)).toBeUndefined();
  });
});
