/** Everyday chat commands: vitals, ping, whoami, model, ask, btw, forget, snub. */

import { buildSystemPrompt } from "../../domain/personality.ts";
import { describeSystem, trendOf } from "../../domain/systemStatus.ts";
import { tokenFor } from "../claudeTokens.ts";
import type { UserRole } from "../../domain/types.ts";
import { NO_TOOLS, type ToolPolicy } from "../../domain/toolPolicy.ts";
import { btwRules } from "../../domain/btwPrompt.ts";
import { buildContextWindow } from "../../domain/conversation.ts";
import { DEFAULT_SNUB_REPLY, formatSnubbed, parseSnubbed } from "../../domain/snub.ts";
import { modelKey, SETTING_KEYS } from "../../infrastructure/db/settingsRepo.ts";
import { type CommandDef, RANK, roleOf, botNameOf, recordsOf } from "./shared.ts";

/**
 * A side question has no tools and is told to answer in two sentences, so it
 * is over in seconds. A minute is already generous, and the point of the
 * command is that it comes back while the real work is still going.
 */
const BTW_TIMEOUT_MS = 90_000;

/** How much of the thread a side question is shown. Context, not a transcript. */
const BTW_WINDOW = 12;

const ROLES: readonly UserRole[] = ["pal", "executer", "admin", "owner"];

/** `<#C123|name>` or a bare channel id, as a channel argument can arrive either way. */
const channelRefOf = (token?: string): string | undefined => {
  const m = token?.match(/^<#([A-Z0-9]+)(?:\|[^>]*)?>$/);
  if (m?.[1]) return m[1];
  return token && /^[CDG][A-Z0-9]+$/.test(token) ? token : undefined;
};

export const CHAT_COMMANDS: readonly CommandDef[] = [
  {
    name: "sys",
    aliases: ["vitals"],
    // Host metrics describe the machine the bot runs on, which is somebody's
    // actual computer. `ping` is the one anybody can ask.
    minRole: "admin",
    usage: "",
    summary: "how the host and I are doing, and whether anything is abnormal",
    run: async ({ deps }) => {
      if (!deps.system) return "I cannot read the system from here.";
      const reading = await deps.system.read();
      return describeSystem(reading, {
        botName: botNameOf(deps),
        trend: trendOf(deps.system.history()),
      });
    },
  },
  {
    name: "ping",
    trivial: true,
    // The brain pings to check itself; a pong in the thread is pure noise. A person typing it still sees the answer.
    quiet: true,
    minRole: "pal",
    usage: "",
    summary: "check I am awake",
    run: () => "pong 🏓 still here, at your service.",
  },
  {
    name: "whoami",
    trivial: true,
    // Asked by the brain to work out who it is talking to. A person typing it still sees the answer.
    quiet: true,
    minRole: "pal",
    usage: "",
    summary: "show your access level",
    run: ({ actor }) => `You are <@${actor.slackId}>, role: *${actor.role}*.`,
  },
  {
    name: "model",
    trivial: true,
    aliases: ["status"],
    minRole: "pal",
    usage: "[role|here|#channel] [name|default]",
    summary: "show my brain and model; admins set one per role or channel",
    run: (ctx) => {
      const { deps, actor, channelId, args, prefix } = ctx;
      const info = deps.botInfo?.();
      if (!info) return "Model info is unavailable.";
      const get = (key: string) => deps.settings?.get(key)?.trim() || undefined;

      // What is being set: a role, this channel, or a named one.
      const first = (args[0] ?? "").toLowerCase();
      const role = roleOf(first);
      const channel =
        role || !first
          ? undefined
          : first === "here" || first === "channel"
            ? channelId
            : channelRefOf(args[0]);
      if (!role && !channel && first) {
        return `A role or a channel, please: \`${prefix} model <${ROLES.join("|")}|here|#channel> [name|default]\``;
      }

      const key = role ? modelKey(role) : modelKey(`channel:${channel}`);
      const label = role ? `*${role}*` : `<#${channel}>`;

      if (!role && !channel) {
        const overrides = [
          ...ROLES.map((r) => [`*${r}*`, get(modelKey(r))] as const),
          [`this channel`, get(modelKey(`channel:${channelId}`))] as const,
        ].filter(([, m]) => m);
        const extra = overrides.length ? `\n${overrides.map(([l, m]) => `- ${l}: \`${m}\``).join("\n")}` : "";
        return `I am *${info.botName}*, running on \`${info.model}\`.${extra}`;
      }

      if (args.length === 1) {
        const own = get(key);
        return own ? `${label} runs on \`${own}\`.` : `${label} uses the default, \`${info.model}\`.`;
      }
      if (RANK[actor.role] < RANK.admin) return "Only admins can change a model.";

      const name = (args[1] ?? "").trim();
      if (name === "default" || name === "reset") {
        deps.settings?.set(key, "");
        return `${label} is back on the default model.`;
      }
      // A model name is one token; taking the first word of a sentence would
      // quietly pin something nobody asked for.
      if (args.length > 2 || !/^[\w.:-]+$/.test(name)) {
        return `Which model? \`${prefix} model ${role ?? "here"} <name|default>\``;
      }
      deps.settings?.set(key, name);
      return `${label} now runs on \`${name}\`.${channel ? " That beats any role model here." : ""}`;
    },
  },
  {
    name: "ask",
    minRole: "pal",
    usage: "<question>",
    summary: "ask me something in one shot",
    run: async ({ deps, actor, channelId, rest, prefix, threadTs }) => {
      const question = rest.trim();
      if (!question) return `Ask me something: \`${prefix} ask <question>\``;
      if (!deps.llm) return "My brain is not wired up right now.";
      const ctx = deps.promptContext?.() ?? { learnings: [] };
      const system = buildSystemPrompt({ botName: ctx.botName, base: ctx.base, learnings: ctx.learnings });
      const reply = await deps.llm.complete({
        system,
        messages: [{ role: "user", content: question }],
        assistantName: ctx.botName,
        policy: deps.toolPolicy?.(actor.role, channelId),
        oauthToken: tokenFor(deps, actor),
        bill: { actor: actor.slackId, kind: "ask", channel: channelId, threadTs },
      });
      return reply.trim() || "I do not have anything useful to add there.";
    },
  },
  {
    name: "btw",
    aliases: ["side"],
    minRole: "pal",
    usage: "<question>",
    summary: "a quick side question - answered without disturbing the work in this thread",
    run: async ({ deps, actor, channelId, threadTs, rest, prefix }) => {
      const question = rest.trim();
      if (!question) return `What is the side question? \`${prefix} btw <question>\``;
      if (!deps.llm) return "My brain is not wired up right now.";
      const ctx = deps.promptContext?.() ?? { learnings: [] };
      // Read the thread, do NOT join it: stored history, never the session.
      // Resuming would put the aside into the context the real work runs in,
      // which is the one thing this command exists to avoid.
      const history = threadTs
        ? deps.messages.recentForThread(channelId, threadTs, BTW_WINDOW)
        : deps.messages.recentForChannel(channelId, BTW_WINDOW);
      const system =
        buildSystemPrompt({ botName: ctx.botName, base: ctx.base, learnings: ctx.learnings }) + btwRules();
      // No tools, by DENIAL. An allow-list pre-approves what is on it and does
      // not refuse what is off it (measured), so an empty allow-list would be
      // no restriction at all - and the running turn shares this machine.
      const sandbox = deps.toolPolicy?.("pal", channelId);
      const policy: ToolPolicy = {
        skipPermissions: false,
        disallowedTools: NO_TOOLS,
        timeoutMs: BTW_TIMEOUT_MS,
        ...(sandbox?.cwd ? { cwd: sandbox.cwd } : {}),
      };
      const reply = await deps.llm.complete({
        system,
        messages: [
          ...buildContextWindow(history, BTW_WINDOW),
          { role: "user" as const, content: question, speakerId: actor.slackId },
        ],
        assistantName: ctx.botName,
        policy,
        oauthToken: tokenFor(deps, actor),
        bill: { actor: actor.slackId, kind: "btw", channel: channelId, threadTs },
      });
      // Nothing is appended to `messages` on the way out, so the thread's next
      // real turn never sees this exchange in its unseen turns.
      return reply.trim() || "Nothing useful to add on that one.";
    },
  },
  {
    name: "forget",
    // Wipes the channel for everyone in it, not just the asker.
    minRole: "executer",
    destructive: true,
    usage: "",
    summary: "wipe my memory of this channel",
    run: ({ deps, channelId }) => {
      const removed = deps.messages.clearChannel(channelId);
      return removed > 0 ? `Forgotten. Wiped ${removed} turns from this channel.` : "Nothing to forget here.";
    },
  },
  {
    name: "snub",
    minRole: "admin",
    usage: "[@user] | off <@user> | reply <what to tell them> | list",
    summary: "turn someone away for good, so their asking stops reaching the deciders",
    run: ({ deps, args, rest, prefix }) => {
      if (!deps.settings) return "I have nowhere to keep that right now.";
      const current = parseSnubbed(deps.settings.get(SETTING_KEYS.snubbed));
      const sub = (args[0] ?? "").toLowerCase();

      if (!sub || sub === "list") {
        const line = deps.settings.get(SETTING_KEYS.snubReply)?.trim() || DEFAULT_SNUB_REPLY;
        return current.length === 0
          ? `Nobody is snubbed. \`${prefix} snub @user\` to add one.`
          : `${current.map((id) => `- <@${id}>`).join("\n")}\n\nthey are told: _${line}_`;
      }

      if (sub === "reply") {
        const line = rest.slice(rest.indexOf(args[0] ?? "") + (args[0] ?? "").length).trim();
        if (!line) return `What should they be told? \`${prefix} snub reply <line>\``;
        deps.settings.set(SETTING_KEYS.snubReply, line);
        return `they will be told: _${line}_`;
      }

      const off = sub === "off" || sub === "remove" || sub === "un";
      const who = parseSnubbed(off ? (args[1] ?? "") : (args[0] ?? ""))[0];
      if (!who) return `Which person? \`${prefix} snub ${off ? "off " : ""}@user\``;

      if (off) {
        if (!current.includes(who)) return "they were not snubbed.";
        deps.settings.set(SETTING_KEYS.snubbed, formatSnubbed(current.filter((id) => id !== who)));
        return `<@${who}> can ask again.`;
      }
      // Snubbing someone on the allowlist would be a contradiction: they are
      // already in, and the snub only ever answers a REQUEST for access.
      if (recordsOf(deps).get(who)) return `<@${who}> is already on the list - \`${prefix} kick\` is what you want.`;
      if (current.includes(who)) return "they are already snubbed.";
      deps.settings.set(SETTING_KEYS.snubbed, formatSnubbed([...current, who]));
      return `<@${who}> will be turned away without troubling anyone 😏`;
    },
  },
];
