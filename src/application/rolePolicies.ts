/**
 * Role policies applied where the bot reads its allowlist.
 *
 * Every role check in the bot - chat access, command gates, buttons, the run
 * bridge, GitHub calls - starts from `users.get`. Wrapping the repo once, at
 * the composition root, is what makes a switched-off role grant nothing
 * anywhere, rather than in whichever call sites remembered to ask. The
 * dashboard keeps the raw repo, since it has to see and edit those members.
 */
import type { UserRole } from "../domain/types.ts";
import { enforcedUser, isRoleEnabled, type RolePolicy } from "../domain/rolePolicy.ts";
import type { UserRepo } from "../infrastructure/db/userRepo.ts";

export const enforceRolePolicies = (users: UserRepo, policyOf: (role: UserRole) => RolePolicy): UserRepo => ({
  ...users,
  get: (slackId) => enforcedUser(users.get(slackId), policyOf),
  list: () => users.list().filter((u) => isRoleEnabled(policyOf(u.role))),
});

/**
 * The role a user holds when that role is switched off, so they can be told
 * so plainly instead of being raised to the owner as a stranger asking in.
 */
export const disabledRoleOf =
  (users: UserRepo, policyOf: (role: UserRole) => RolePolicy) =>
  (slackId: string): UserRole | undefined => {
    const user = users.get(slackId);
    return user && !isRoleEnabled(policyOf(user.role)) ? user.role : undefined;
  };
