/** `slack-methods`: the Slack Web API methods a turn may call beyond the built-in ones. See domain/slackProxy.ts. */
import {
  REFUSED_METHOD_FAMILIES,
  SLACK_PROXY_METHODS,
  isChannelParam,
  parseExtraMethods,
  refuseExtraMethod,
  serializeExtraMethods,
  type ExtraSlackMethod,
} from "../../domain/slackProxy.ts";
import { SETTING_KEYS } from "../../infrastructure/db/settingsRepo.ts";
import { type CommandDef } from "./shared.ts";

const DEFAULT_CHANNEL_PARAM = "channel";

const describe = (m: ExtraSlackMethod): string => (m.kind === "write" ? `\`${m.method}\` (write, channel param \`${m.channelParam}\`)` : `\`${m.method}\` (read)`);

export const SLACK_METHODS_COMMANDS: readonly CommandDef[] = [
  {
    name: "slack-methods",
    // Widening what a turn may do in Slack is the owner's call, like `post`.
    minRole: "owner",
    ownHelp: true,
    usage: "list | add <method> read|write [channelParam] | remove <method> | help",
    summary: "list, add or remove the Slack Web API methods a turn may call beyond the built-in ones; owner only",
    run: async ({ deps, args, prefix }) => {
      const usage = `\`${prefix} slack-methods list | add <method> read|write [channelParam] | remove <method>\``;
      const help = `${usage}
Slack methods a turn may call through its Slack helper, beyond the built-in ones (those cannot be removed here).
- \`add conversations.setTopic write\` - a *write* is locked to the channel the turn runs in, exactly like the built-in writes. \`channelParam\` is the parameter that names the channel (default \`${DEFAULT_CHANNEL_PARAM}\`; \`channel_id\` for some methods) and must be one the method really takes.
- \`add users.list read\` - a *read* may look at any channel and cannot be locked to one, so add only methods that change nothing.
- Method names look like \`family.method\`. \`${REFUSED_METHOD_FAMILIES.map((f) => `${f}.*`).join("\`, \`")}\` are refused: they touch tokens, apps or the workspace admin.
- The bot's token needs the matching Slack scope too (\`conversations.setTopic\` needs \`channels:manage\`, plus \`groups:write\` for private channels); the call fails with \`missing_scope\` otherwise.`;
      const first = (args[0] ?? "list").toLowerCase();
      if (first === "help" || first === "?") return help;
      if (!deps.settings) return "Settings are not available, so the list cannot be changed.";
      const extra = parseExtraMethods(deps.settings.get(SETTING_KEYS.slackExtraMethods));
      const save = (next: readonly ExtraSlackMethod[]): void => deps.settings?.set(SETTING_KEYS.slackExtraMethods, serializeExtraMethods(next));

      if (first === "list") {
        const added = extra.length ? extra.map((m) => `- ${describe(m)}`).join("\n") : "- none";
        return `*Built in* (always on): reads ${SLACK_PROXY_METHODS.read.map((m) => `\`${m}\``).join(", ")}; writes ${SLACK_PROXY_METHODS.write.map((m) => `\`${m}\``).join(", ")}.\n*Added by the owner:*\n${added}`;
      }

      const method = args[1] ?? "";
      if (first === "add") {
        const kind = (args[2] ?? "").toLowerCase();
        if (!method || (kind !== "read" && kind !== "write")) return `Name the method and whether it reads or writes: ${usage}`;
        const refused = refuseExtraMethod(method);
        if (refused) return `Not added: ${refused}.`;
        let entry: ExtraSlackMethod;
        if (kind === "read") {
          if (args[3]) return "A read has no channel parameter: it is not locked to a channel. Leave it off, or add it as a `write`.";
          entry = { method, kind };
        } else {
          const channelParam = args[3] ?? DEFAULT_CHANNEL_PARAM;
          if (!isChannelParam(channelParam)) return `\`${channelParam}\` is not a parameter name (lowercase letters, digits and \`_\`).`;
          entry = { method, kind, channelParam };
        }
        const replaced = extra.some((m) => m.method === method);
        save([...extra.filter((m) => m.method !== method), entry]);
        return `${replaced ? "Updated" : "Added"} ${describe(entry)}. Turns can call it now${entry.kind === "write" ? `, only in the channel they run in` : ""}.`;
      }

      if (first === "remove") {
        if (!method) return `Name the method to remove: ${usage}`;
        if (SLACK_PROXY_METHODS.read.some((m) => m === method) || SLACK_PROXY_METHODS.write.some((m) => m === method)) {
          return `\`${method}\` is built in; only the methods added here can be removed.`;
        }
        if (!extra.some((m) => m.method === method)) return `\`${method}\` is not one of the added methods. \`${prefix} slack-methods list\` shows them.`;
        save(extra.filter((m) => m.method !== method));
        return `Removed \`${method}\`: turns can no longer call it.`;
      }
      return `I do not know \`${first}\`. ${usage}`;
    },
  },
];
