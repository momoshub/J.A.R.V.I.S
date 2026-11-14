/** The owner's role editor: role list | show | create | grant | revoke | delete | rename | rank | describe | on | off | default | perms. */

import { isOwnerRole, OWNER_RANK, type Role } from "../../domain/roles.ts";
import { type PermissionInfo } from "../../domain/permissions.ts";
import {
  createRole,
  deleteRole,
  denyTools,
  describeRole,
  grantPermissions,
  rankRole,
  renameRole,
  revokePermissions,
  setDefaultRole,
  switchRole,
  defaultRoleOf,
  type RoleEditDeps,
} from "../roles.ts";
import { parseDeniedTools } from "../../domain/rolePolicy.ts";
import { type CommandDef, type Context, recordsOf } from "./shared.ts";

const USAGE =
  "list | show <role> | perms [filter] | create <name> [from <role>] | grant <role> <perm...> | revoke <role> <perm...> | delete <role> | rename <old> <new> | rank <role> <n> | describe <role> <text> | on|off <role> | default <role> | denytools <role> <pattern...|none>";

const editDeps = (ctx: Context): RoleEditDeps | undefined =>
  ctx.deps.roleRepo
    ? {
        repo: ctx.deps.roleRepo,
        settings: ctx.deps.settings,
        clock: ctx.deps.clock,
        by: ctx.actor.slackId,
        editor: ctx.actor.role,
        catalogue: ctx.catalogue,
      }
    : undefined;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const members = (ctx: Context, role: string): number =>
  recordsOf(ctx.deps).list().filter((u) => u.role === role).length;

const line = (ctx: Context, r: Role): string => {
  const rank = r.rank === OWNER_RANK ? "top" : String(r.rank);
  const held = isOwnerRole(r.name) ? "everything" : plural(r.grants.length, "permission");
  const off = r.enabled ? "" : " (switched off)";
  return `- *${r.name}*${off} - rank ${rank}, ${plural(members(ctx, r.name) + (isOwnerRole(r.name) && !recordsOf(ctx.deps).get(ctx.deps.ownerSlackId) ? 1 : 0), "person", "people")}, ${held}${r.description ? ` - ${r.description}` : ""}`;
};

const show = (ctx: Context, role: Role): string => {
  if (isOwnerRole(role.name)) return `*owner* - ${role.description}\nIt holds every permission, including managing roles, which nobody else can ever hold.`;
  const byGroup = new Map<string, string[]>();
  for (const id of role.grants) {
    const info = ctx.catalogue.find((p) => p.id === id);
    const group = info?.group ?? "Other";
    byGroup.set(group, [...(byGroup.get(group) ?? []), id]);
  }
  const lines = [...byGroup.entries()].map(([group, ids]) => {
    const short = group === "Commands" ? ids.map((i) => i.replace(/^command:/, "")) : ids;
    return `*${group}* (${ids.length}): ${short.map((i) => `\`${i}\``).join(", ")}`;
  });
  const members_ = recordsOf(ctx.deps).list().filter((u) => u.role === role.name);
  return [
    `*${role.name}* - rank ${role.rank}${role.enabled ? "" : ", switched off"}${role.seed ? `, built in as ${role.seed}` : ""}`,
    role.description || "_no description_",
    `${plural(members_.length, "person", "people")}${members_.length ? `: ${members_.slice(0, 10).map((u) => `<@${u.slackId}>`).join(" ")}${members_.length > 10 ? " ..." : ""}` : ""}`,
    ...(lines.length ? lines : ["Grants nothing yet. `help` and chat still work."]),
    ...(role.deniedTools.length ? [`*Denied tools*: ${role.deniedTools.map((t) => `\`${t}\``).join(", ")}`] : []),
  ].join("\n");
};

const perms = (ctx: Context, filter: string): string => {
  const f = filter.toLowerCase();
  const rows = (ctx.catalogue as readonly PermissionInfo[]).filter(
    (p) => !f || p.id.includes(f) || p.group.toLowerCase().includes(f) || p.label.toLowerCase().includes(f),
  );
  if (rows.length === 0) return `Nothing matches \`${filter}\`.`;
  return rows.slice(0, 60).map((p) => `- \`${p.id}\` - ${p.label}`).join("\n") + (rows.length > 60 ? `\n...and ${rows.length - 60} more - narrow it with a filter.` : "");
};

export const ROLE_COMMANDS: readonly CommandDef[] = [
  {
    name: "role",
    aliases: ["roles"],
    // Seeded to nobody: managing roles is the owner's alone and is never grantable (`isOwnerOnlyPermission`).
    minRole: "owner",
    usage: USAGE,
    summary: "owner only: see, create, edit and delete roles and the permissions they grant (the owner role itself is fixed)",
    run: (ctx) => {
      // Belt and braces: the dispatch gate already refuses everyone else, and `can` never lets a stored grant open this.
      if (!isOwnerRole(ctx.actor.role)) return "Only the owner manages roles.";
      const { args, prefix, deps } = ctx;
      const sub = (args[0] ?? "list").toLowerCase();
      const edit = editDeps(ctx);
      const reply = (r: { ok: true } | { ok: false; error: string }, done: string): string => (r.ok ? done : r.error);
      const needEdit = (): string => "I have nowhere to keep roles right now.";

      if (sub === "list" || sub === "ls") {
        const fallback = defaultRoleOf(ctx.roles, deps.settings);
        return [
          ...ctx.roles.list().map((r) => line(ctx, r)),
          "",
          `A new person from an approved access request gets *${fallback ?? "no role"}*. \`${prefix} role show <role>\` lists what one grants.`,
        ].join("\n");
      }
      if (sub === "perms" || sub === "permissions") return perms(ctx, args.slice(1).join(" "));
      const name = (args[1] ?? "").toLowerCase();
      if (sub === "show") {
        const r = ctx.roles.get(name);
        return r ? show(ctx, r) : name ? `There is no role called *${name}*.` : `\`${prefix} role show <role>\``;
      }
      if (!edit) return needEdit();

      switch (sub) {
        case "create": {
          if (!name) return `\`${prefix} role create <name> [from <role>] [description]\``;
          const from = (args[2] ?? "").toLowerCase() === "from" ? (args[3] ?? "").toLowerCase() : undefined;
          if ((args[2] ?? "").toLowerCase() === "from" && !from) return `Copy from which role? \`${prefix} role create ${name} from <role>\``;
          const description = args.slice(from ? 4 : 2).join(" ");
          const r = createRole(edit, name, from, description);
          return r.ok
            ? `Created *${r.role.name}* (rank ${r.role.rank}${from ? `, ${plural(r.role.grants.length, "permission")} copied from *${from}*` : ", no permissions yet"}). \`${prefix} role grant ${r.role.name} <perm...>\`, then \`${prefix} add @user ${r.role.name}\`.`
            : r.error;
        }
        case "grant": {
          if (!name || args.length < 3) return `\`${prefix} role grant <role> <perm...>\` - ids like \`command:watch\`, \`github:pr-create\`, \`mcp:notion\`, or a family: \`command:*\`, \`github:*\`. \`${prefix} role perms\` lists them.`;
          const r = grantPermissions(edit, name, args.slice(2));
          return r.ok
            ? r.added.length
              ? `*${r.role.name}* now also grants ${r.added.length > 12 ? plural(r.added.length, "permission") : r.added.map((p) => `\`${p}\``).join(", ")}. It applies on the next message.`
              : `*${r.role.name}* already held those.`
            : r.error;
        }
        case "revoke": {
          if (!name || args.length < 3) return `\`${prefix} role revoke <role> <perm...>\``;
          const r = revokePermissions(edit, name, args.slice(2));
          return r.ok
            ? r.removed.length
              ? `*${r.role.name}* no longer grants ${r.removed.length > 12 ? plural(r.removed.length, "permission") : r.removed.map((p) => `\`${p}\``).join(", ")}.`
              : `*${r.role.name}* did not hold those.`
            : r.error;
        }
        case "delete":
        case "rm": {
          if (!name) return `\`${prefix} role delete <role>\``;
          const holders = recordsOf(deps).list().filter((u) => u.role === name);
          const r = deleteRole(edit, name, holders);
          return r.ok ? `Deleted *${r.role.name}*.` : r.error;
        }
        case "rename": {
          const to = (args[2] ?? "").toLowerCase();
          if (!name || !to) return `\`${prefix} role rename <old> <new>\` (everyone who holds it moves with it)`;
          const r = renameRole(edit, name, to);
          return r.ok ? `Renamed *${name}* to *${to}*; everyone who held it still does.` : r.error;
        }
        case "rank": {
          const n = Number(args[2]);
          if (!name || args[2] === undefined) return `\`${prefix} role rank <role> <n>\` - higher outranks lower; a role only manages people below its own rank.`;
          return reply(rankRole(edit, name, n), `*${name}* is now rank ${n}.`);
        }
        case "describe":
          return reply(describeRole(edit, name, args.slice(2).join(" ")), `Updated the description of *${name}*.`);
        case "on":
        case "off":
          return reply(switchRole(edit, name, sub === "on"), `*${name}* is switched ${sub}${sub === "off" ? ": its members are treated as not on the list until it is on again" : ""}.`);
        case "default":
          return reply(setDefaultRole(edit, name), `An approved access request now gets *${name}*.`);
        case "denytools": {
          const raw = args.slice(2).join(" ");
          const parsed = parseDeniedTools(/^(none|clear)$/i.test(raw.trim()) ? "" : raw);
          if (!name) return `\`${prefix} role denytools <role> <pattern...|none>\` - CLI tool patterns such as \`Bash(rm:*)\`, added to the role's denials.`;
          if (!parsed.ok) return parsed.error;
          return reply(denyTools(edit, name, parsed.tools), parsed.tools.length ? `*${name}* is denied ${parsed.tools.map((t) => `\`${t}\``).join(", ")}.` : `*${name}* has no extra denied tools.`);
        }
        default:
          return `\`${prefix} role ${USAGE}\``;
      }
    },
  },
];
