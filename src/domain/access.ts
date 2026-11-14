/**
 * Pure access-control logic.
 *
 * the bot answers to a fixed allowlist. The owner always wins and can never be
 * locked out. Everything here is a pure function of its inputs so it is trivial
 * to test and reason about.
 */
import { OWNER_ROLE, mayAssign, type RoleBook } from "./roles.ts";
import type { AccessDecision, AllowedUser, UserRole } from "./types.ts";

/**
 * Decide whether a Slack user may talk to the bot
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
        role: OWNER_ROLE,
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
 * it, otherwise undefined. Whether the actor may run `add` / `promote` at all is
 * the command's own permission; this is the rank rule - an actor only touches
 * roles that rank below their own, so an admin cannot hand out or take away admin.
 */
export const validateRoleChange = (
  book: RoleBook,
  actorRole: UserRole,
  /** Absent when the target is not on the list yet. */
  targetCurrentRole: UserRole | undefined,
  targetNextRole: UserRole,
  targetIsOwner: boolean,
): string | undefined => {
  if (targetIsOwner) return "The owner's role cannot be changed.";
  if (!book.get(targetNextRole)) return `There is no role called *${targetNextRole}*.`;
  return mayAssign(book, actorRole, targetCurrentRole, targetNextRole);
};

/** Guard removing a user from the allowlist. */
export const validateRemoval = (
  book: RoleBook,
  actorRole: UserRole,
  targetRole: UserRole,
  targetIsOwner: boolean,
): string | undefined => {
  if (targetIsOwner) return "The owner cannot be removed.";
  return mayAssign(book, actorRole, targetRole, undefined);
};
