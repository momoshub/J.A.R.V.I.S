/**
 * Pure access-control logic.
 *
 * E.V. answers to a fixed allowlist. The owner always wins and can never be
 * locked out. Everything here is a pure function of its inputs so it is trivial
 * to test and reason about.
 */
import type { AccessDecision, AllowedUser, UserRole } from "./types.ts";

/** Can this user manage the allowlist (add/remove/change roles)? */
export const canManageUsers = (role: UserRole): boolean =>
  role === "owner" || role === "admin";

/** Only the owner may promote/demote admins or remove other admins. */
export const canManageAdmins = (role: UserRole): boolean => role === "owner";

/**
 * Decide whether a Slack user may talk to E.V.
 *
 * The owner is allowed even if they are somehow missing from the allowlist, so
 * a broken database can never lock the owner out.
 */
export const decideAccess = (
  slackUserId: string,
  ownerSlackId: string,
  lookup: (slackId: string) => AllowedUser | undefined,
): AccessDecision => {
  const existing = lookup(slackUserId);
  if (existing) return { allowed: true, user: existing };

  if (slackUserId === ownerSlackId) {
    return {
      allowed: true,
      user: {
        slackId: ownerSlackId,
        role: "owner",
        displayName: "",
        addedBy: "system",
        createdAt: 0,
      },
    };
  }

  return {
    allowed: false,
    reason:
      "You are not on my access list. Ask the owner to add you if you think that is a mistake.",
  };
};

/**
 * Guard a role change. Returns an error string when the actor may not perform
 * it, otherwise undefined.
 */
export const validateRoleChange = (
  actorRole: UserRole,
  targetCurrentRole: UserRole,
  targetNextRole: UserRole,
  targetIsOwner: boolean,
): string | undefined => {
  if (targetIsOwner) return "The owner's role cannot be changed.";
  if (!canManageUsers(actorRole)) return "You cannot manage users.";
  const touchesAdmin =
    targetCurrentRole === "admin" ||
    targetNextRole === "admin" ||
    targetNextRole === "owner";
  if (touchesAdmin && !canManageAdmins(actorRole)) {
    return "Only the owner can manage admins.";
  }
  if (targetNextRole === "owner") return "There can only be one owner.";
  return undefined;
};

/** Guard removing a user from the allowlist. */
export const validateRemoval = (
  actorRole: UserRole,
  targetRole: UserRole,
  targetIsOwner: boolean,
): string | undefined => {
  if (targetIsOwner) return "The owner cannot be removed.";
  if (!canManageUsers(actorRole)) return "You cannot manage users.";
  if (targetRole === "admin" && !canManageAdmins(actorRole)) {
    return "Only the owner can remove an admin.";
  }
  return undefined;
};
