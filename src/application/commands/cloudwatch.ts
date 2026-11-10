/** `cloudwatch`: the one allowed way to query CloudWatch Logs Insights. See application/cloudwatch.ts. */
import { helpText } from "../../domain/cloudwatch.ts";
import { SETTING_KEYS } from "../../infrastructure/db/settingsRepo.ts";
import { askCloudwatch } from "../cloudwatch.ts";
import { RANK, type CommandDef } from "./shared.ts";

export const CLOUDWATCH_COMMANDS: readonly CommandDef[] = [
  {
    name: "cloudwatch",
    aliases: ["cw"],
    // pal is refused; below the floor the generic "needs executer access" answers.
    // The finer rule (executer/admin confirm, owner runs) is in `askCloudwatch`.
    minRole: "executer",
    ownHelp: true,
    usage: "[--group /log/group] [--last 15m | --from <t> --to <t>] [--region r] [--limit n] <insights query> | help | default <log group|reset>",
    summary: "query CloudWatch Logs Insights (executer/admin confirm first, owner runs directly)",
    run: async (ctx) => {
      const { deps, actor, args, prefix } = ctx;
      const first = (args[0] ?? "").toLowerCase();
      if (first === "help" || first === "?") return helpText(prefix);

      if (first === "default") {
        const group = args[1];
        const current = deps.settings?.get(SETTING_KEYS.cloudwatchGroup) || "none";
        if (!group) return `The default log group is ${current === "none" ? "not set" : `\`${current}\``}. \`${prefix} cloudwatch default /log/group\` sets it, \`reset\` clears it.`;
        if (RANK[actor.role] < RANK.admin) return "Only admins can change the default log group.";
        if (group === "reset") {
          deps.settings?.set(SETTING_KEYS.cloudwatchGroup, "");
          return "Cleared the default log group: every query must name one with `--group`.";
        }
        if (!/^\/[A-Za-z0-9_\-/.#]+(,\/[A-Za-z0-9_\-/.#]+)*$/.test(group)) {
          return `\`${group}\` is not a log group name (they start with \`/\`, like \`/ecs/my-service\`).`;
        }
        deps.settings?.set(SETTING_KEYS.cloudwatchGroup, group);
        return `Queries without \`--group\` now use \`${group}\`.`;
      }

      if (!deps.cloudwatch) return "CloudWatch queries are not wired up on this instance.";
      return askCloudwatch(
        deps.cloudwatch,
        { actor, channelId: ctx.channelId, threadTs: ctx.threadTs, reply: ctx.reply, usage: `${prefix} cloudwatch [--group /log/group] [--last 15m] <insights query>` },
        args,
      );
    },
  },
];
