/** Who may talk to the bot and what they spend: spend, users, add, remove, promote, demote. */

import { validateRemoval, validateRoleChange } from "../../domain/access.ts";
import type { UserRole } from "../../domain/types.ts";
import { spendReport } from "../../domain/spendReport.ts";
import { type Context, type CommandDef, slackIdOf, roleOf, parseWindow, recordsOf } from "./shared.ts";

const changeRole = (ctx: Context, slackId: string, next: UserRole, requireExisting: boolean): string => {
  const records = recordsOf(ctx.deps);
  const target = records.get(slackId);
  if (requireExisting && !target) return "I do not know that user - add them first.";
  const err = validateRoleChange(ctx.actor.role, target?.role ?? "pal", next, slackId === ctx.deps.ownerSlackId);
  if (err) return err;
  if (target) records.setRole(slackId, next);
  else
    records.upsert({
      slackId,
      role: next,
      displayName: "",
      addedBy: ctx.actor.slackId,
      createdAt: ctx.deps.clock(),
    });
  return `Done. <@${slackId}> is now *${next}*.`;
};

export const PEOPLE_COMMANDS: readonly CommandDef[] = [
  {
    name: "spend",
    aliases: ["cost", "tokens"],
    // It names people and what they cost, which is nobody's business at pal
    // level, and it describes the bill for somebody's own account.
    minRole: "admin",
    usage: "[hours|7d]",
    summary: "what the model has cost, by person and by command",
    // Asked by the brain, it relays the numbers itself: posted straight into
    // the thread it lands before the brain can shape it the way it was asked.
    quiet: true,
    run: async ({ deps, args }) => {
      if (!deps.usage) return "I am not recording what runs cost right now.";
      const windowMs = parseWindow(args[0]) ?? 24 * 60 * 60_000;
      const since = deps.clock() - windowMs;
      const byUser = deps.usage.byUser(since, 15);
      // Names, never tags: a cost report that pings everyone on it is a
      // report nobody asked to be notified of. People who spent but are no
      // longer on the list are looked up in Slack rather than tagged.
      const names = new Map(
        deps.users
          .list()
          .filter((u) => u.displayName)
          .map((u) => [u.slackId, u.displayName] as const),
      );
      const missing = byUser.map((u) => u.key).filter((k) => k && !names.has(k));
      if (missing.length > 0 && deps.slack) {
        const found = await deps.slack.resolveNames(missing).catch(() => ({}) as Record<string, string>);
        for (const [id, name] of Object.entries(found)) if (name) names.set(id, name);
      }
      return spendReport(
        deps.usage.totals(since),
        byUser,
        deps.usage.byKind(since, 15),
        windowMs,
        names,
      );
    },
  },
  {
    name: "users",
    aliases: ["list"],
    minRole: "admin",
    usage: "",
    summary: "list who I answer to",
    // Like spend: the brain reads it and answers, it is not dropped in the thread.
    quiet: true,
    run: ({ deps }) => {
      const users = recordsOf(deps).list();
      if (users.length === 0) return "Nobody on the list yet, oddly enough.";
      // Names and ids, never tags: listing everyone must not ping everyone.
      // A member hidden by the policy is still listed, marked, so it can be fixed.
      return users
        .map((u) => {
          const off = deps.rawUsers && !deps.users.get(u.slackId) ? " (role switched off)" : "";
          return `- ${u.displayName || "unnamed"} - *${u.role}*${off} \`${u.slackId}\``;
        })
        .join("\n");
    },
  },
  {
    name: "add",
    minRole: "admin",
    usage: "@user [pal|executer|admin]",
    summary: "grant access (admin role is owner-only)",
    run: (ctx) => {
      const slackId = slackIdOf(ctx.args[0]);
      if (!slackId) return `Who? \`${ctx.prefix} add @user [pal|executer|admin]\``;
      return changeRole(ctx, slackId, roleOf(ctx.args[1]?.toLowerCase()) ?? "pal", false);
    },
  },
  {
    name: "remove",
    aliases: ["kick"],
    minRole: "admin",
    usage: "@user",
    summary: "revoke access",
    run: (ctx) => {
      const slackId = slackIdOf(ctx.args[0]);
      if (!slackId) return `Who? \`${ctx.prefix} remove @user\``;
      const target = recordsOf(ctx.deps).get(slackId);
      if (!target) return "They are not on the list to begin with.";
      const err = validateRemoval(ctx.actor.role, target.role, slackId === ctx.deps.ownerSlackId);
      if (err) return err;
      recordsOf(ctx.deps).remove(slackId);
      return `Access revoked for <@${slackId}>.`;
    },
  },
  {
    name: "promote",
    minRole: "owner",
    usage: "@user",
    summary: "make someone an admin",
    run: (ctx) => {
      const slackId = slackIdOf(ctx.args[0]);
      return slackId ? changeRole(ctx, slackId, "admin", true) : `Who? \`${ctx.prefix} promote @user\``;
    },
  },
  {
    name: "demote",
    minRole: "owner",
    usage: "@user",
    summary: "drop someone to pal",
    run: (ctx) => {
      const slackId = slackIdOf(ctx.args[0]);
      return slackId ? changeRole(ctx, slackId, "pal", true) : `Who? \`${ctx.prefix} demote @user\``;
    },
  },
];
