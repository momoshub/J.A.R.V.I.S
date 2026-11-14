import { describe, expect, test } from "bun:test";
import { seededBook } from "../../src/domain/roleSeed.ts";
import {
  decideAccess,
  validateRemoval,
  validateRoleChange,
} from "../../src/domain/access.ts";
import type { AllowedUser } from "../../src/domain/types.ts";

const OWNER = "U0OWNER0001";

const book = seededBook();

const makeUser = (over: Partial<AllowedUser> = {}): AllowedUser => ({
  slackId: "U1",
  role: "pal",
  displayName: "Test",
  addedBy: "system",
  createdAt: 0,
  ...over,
});

describe("decideAccess", () => {
  test("allows a user present on the allowlist", () => {
    const user = makeUser({ slackId: "U1", role: "pal" });
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
    expect(validateRoleChange(book, "owner", "owner", "admin", true)).toBeDefined();
  });

  test("member cannot manage users", () => {
    expect(validateRoleChange(book, "pal", "pal", "admin", false)).toBeDefined();
  });

  test("admin cannot touch admin roles", () => {
    expect(validateRoleChange(book, "admin", "pal", "admin", false)).toBeDefined();
    expect(validateRoleChange(book, "admin", "admin", "pal", false)).toBeDefined();
  });

  test("owner can promote a member to admin", () => {
    expect(validateRoleChange(book, "owner", "pal", "admin", false)).toBeUndefined();
  });

  test("nobody can mint a second owner", () => {
    expect(validateRoleChange(book, "owner", "pal", "owner", false)).toBeDefined();
  });

  test("admin can add a plain member", () => {
    expect(validateRoleChange(book, "admin", "pal", "pal", false)).toBeUndefined();
  });
});

describe("validateRemoval", () => {
  test("owner cannot be removed", () => {
    expect(validateRemoval(book, "owner", "owner", true)).toBeDefined();
  });

  test("member cannot remove anyone", () => {
    expect(validateRemoval(book, "pal", "pal", false)).toBeDefined();
  });

  test("admin cannot remove another admin", () => {
    expect(validateRemoval(book, "admin", "admin", false)).toBeDefined();
  });

  test("owner can remove an admin", () => {
    expect(validateRemoval(book, "owner", "admin", false)).toBeUndefined();
  });

  test("admin can remove a member", () => {
    expect(validateRemoval(book, "admin", "pal", false)).toBeUndefined();
  });
});
