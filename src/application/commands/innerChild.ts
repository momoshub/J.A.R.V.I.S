/** `inner-child`: switch the self-review feature on or off and say where it works. See application/innerChild.ts. */

import { PERM } from "../../domain/permissions.ts";
import { SETTING_KEYS } from "../../infrastructure/db/settingsRepo.ts";
import { type CommandDef } from "./shared.ts";

const channelIdOf = (raw: string): string | undefined =>
  raw.match(/^<#([CG][A-Z0-9]+)(?:\|[^>]*)?>$/)?.[1] ?? raw.match(/^[CG][A-Z0-9]+$/)?.[0];

export const INNER_CHILD_COMMANDS: readonly CommandDef[] = [
  {
    name: "inner-child",
    minRole: "pal",
    usage: "[status] | on | off | autofix on|off | channel <#channel>|off",
    summary: "whether I watch my own turns, whether I fix myself (autofix, off by default), in which channel, and how many issues are open or queued",
    run: ({ can, deps, args, prefix }) => {
      const settings = deps.settings;
      if (!settings) return "I have nowhere to keep settings right now.";
      const sub = (args[0] ?? "status").toLowerCase();
      const channel = () => settings.get(SETTING_KEYS.innerChildChannel)?.trim() ?? "";
      const paused = () => settings.get(SETTING_KEYS.innerChild)?.trim().toLowerCase() === "off";
      const autofixOn = () => settings.get(SETTING_KEYS.innerChildAutofix)?.trim().toLowerCase() === "on";
      const setChannelHint = `\`${prefix} inner-child channel #channel\``;

      if (sub === "status") {
        const ch = channel();
        const cursor = Number(settings.get(SETTING_KEYS.innerChildCursor));
        const open = deps.selfIssues?.openCount();
        const queued = deps.selfIssues?.queuedCount();
        return [
          ch && !paused() ? "inner child is *on*" : paused() ? "inner child is *off*" : "inner child is *inactive* (no channel)",
          ch ? `channel: <#${ch}>` : `channel: none - ${setChannelHint}`,
          `autofix: ${autofixOn() ? "*on*" : `off - \`${prefix} inner-child autofix on\` lets it fix queued issues`}`,
          ...(open === undefined ? [] : [`open issues (queued or being fixed): ${open}`]),
          ...(queued === undefined ? [] : [`queued, waiting for a fix: ${queued}`]),
          ...(Number.isFinite(cursor) && cursor > 0 ? [`last read up to: ${new Date(cursor).toISOString()}`] : []),
        ].join("\n");
      }

      if (sub === "on" || sub === "off") {
        if (!can(PERM.manageSettings)) return "You are not allowed to switch the inner child.";
        if (sub === "off") {
          settings.set(SETTING_KEYS.innerChild, "off");
          return "inner child off - it stops reading my turns and starting fixes; the channel is kept";
        }
        settings.set(SETTING_KEYS.innerChild, "on");
        // Resume from now: whatever happened while it was off is not read.
        settings.set(SETTING_KEYS.innerChildCursor, String(Date.now()));
        const ch = channel();
        return ch
          ? `inner child on - it works in <#${ch}>`
          : `inner child is on, but stays inactive until a channel is set: ${setChannelHint}`;
      }

      if (sub === "autofix") {
        if (!can(PERM.manageSettings)) return "You are not allowed to switch the inner child's autofix.";
        const v = (args[1] ?? "").toLowerCase();
        if (v !== "on" && v !== "off") return `Usage: \`${prefix} inner-child autofix on|off\``;
        settings.set(SETTING_KEYS.innerChildAutofix, v);
        return v === "on"
          ? "inner child autofix on - it starts fixing queued issues itself, at most 2 a day"
          : "inner child autofix off - issues are still filed and queued, none is fixed";
      }

      if (sub === "channel") {
        if (!can(PERM.manageSettings)) return "You are not allowed to move the inner child.";
        const raw = args[1] ?? "";
        if (/^(off|none|stop)$/i.test(raw)) {
          settings.remove(SETTING_KEYS.innerChildChannel);
          return "inner child has no channel now, so it is inactive";
        }
        const id = channelIdOf(raw);
        if (!id) return `Which channel? ${setChannelHint}`;
        settings.set(SETTING_KEYS.innerChildChannel, id);
        return paused()
          ? `inner child channel is <#${id}>, but it is off - \`${prefix} inner-child on\``
          : `inner child now announces and fixes in <#${id}>`;
      }

      return `Unknown option. Usage: \`${prefix} inner-child [status] | on | off | autofix on|off | channel <#channel>|off\``;
    },
  },
];
