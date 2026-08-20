/**
 * Command layer.
 *
 * A single registry of predefined commands, each invokable two ways:
 *   - Slack slash command:  `/ev <name> <args...>`  (one registration, sub-routed)
 *   - Template message:      `//ev <name> <args...>` (or the legacy `!<name>`)
 *
 * Both interfaces resolve to the same line via `commandLineOf` and run through
 * `dispatchCommand`, which enforces per-command role gates before touching repos
 * or the brain. Everything is data-driven so adding a command is one entry.
 */
import { buildSystemPrompt } from "../domain/personality.ts";
import {
  validateRemoval,
  validateRoleChange,
} from "../domain/access.ts";
import { reviewPrompt } from "../domain/reviewPrompt.ts";
import { EMOJI_CATEGORY_NAMES, pickBomb } from "../domain/emoji.ts";
import { parseMessageLink } from "../domain/slackLinks.ts";
import type { AllowedUser, PromptContext, UserRole } from "../domain/types.ts";
import type { ToolPolicy } from "../domain/toolPolicy.ts";
import type { Clock, LlmPort } from "./ports.ts";
import type { SlackAdminPort } from "./slackAdmin.ts";
import type { DraftReply } from "./draftReply.ts";
import type { MessageRepo } from "../infrastructure/db/messageRepo.ts";
import type { UserRepo } from "../infrastructure/db/userRepo.ts";
import type { LearningsRepo } from "../infrastructure/db/learningsRepo.ts";
import type { CommandLogRepo } from "../infrastructure/db/commandLogRepo.ts";

export type CommandDeps = {
  users: UserRepo;
  messages: MessageRepo;
  learnings?: LearningsRepo;
  llm?: LlmPort;
  promptContext?: () => PromptContext;
  botInfo?: () => { botName: string; model: string };
  commandLog?: CommandLogRepo;
  /** Names of disabled commands (managed from the dashboard). */
  disabledCommands?: () => ReadonlySet<string>;
  /** Slack Web API operations, for the power tools (br, jrp). */
  slack?: SlackAdminPort;
  /** AI reply drafting, for jrp. */
  draft?: DraftReply;
  /** Per-role CLI tool policy (sandbox/allow-list), for ask + review. */
  toolPolicy?: (role: UserRole) => ToolPolicy;
  clock: Clock;
  ownerSlackId: string;
};

const REACTION_BOMB_SIZE = 18;

/** Public metadata for one command, for the dashboard. */
export type CommandInfo = {
  name: string;
  aliases: string[];
  minRole: UserRole;
  usage: string;
  summary: string;
};

type Context = {
  deps: CommandDeps;
  actor: AllowedUser;
  channelId: string;
  args: string[];
  rest: string;
};

type CommandDef = {
  name: string;
  aliases?: readonly string[];
  minRole: UserRole;
  usage: string;
  summary: string;
  run: (ctx: Context) => string | Promise<string>;
};

const RANK: Record<UserRole, number> = { pal: 0, executer: 1, admin: 2, owner: 3 };
const MENTION = /<@([A-Z0-9]+)(?:\|[^>]+)?>/;
const LEADING_MENTION = /^<@[A-Z0-9]+(?::[^>]+|\|[^>]+)?>\s*/;

const slackIdOf = (token?: string): string | undefined => {
  if (!token) return undefined;
  const m = token.match(MENTION);
  if (m?.[1]) return m[1];
  return /^[UW][A-Z0-9]+$/.test(token) ? token : undefined;
};

const roleOf = (token?: string): UserRole | undefined =>
  token === "owner" || token === "admin" || token === "executer" || token === "pal" ? token : undefined;

const botNameOf = (deps: CommandDeps): string =>
  deps.botInfo?.().botName ?? deps.promptContext?.().botName ?? "Evie";

const changeRole = (ctx: Context, slackId: string, next: UserRole, requireExisting: boolean): string => {
  const target = ctx.deps.users.get(slackId);
  if (requireExisting && !target) return "I do not know that user - add them first.";
  const err = validateRoleChange(
    ctx.actor.role,
    target?.role ?? "pal",
    next,
    slackId === ctx.deps.ownerSlackId,
  );
  if (err) return err;
  if (target) ctx.deps.users.setRole(slackId, next);
  else
    ctx.deps.users.upsert({
      slackId,
      role: next,
      displayName: "",
      addedBy: ctx.actor.slackId,
      createdAt: ctx.deps.clock(),
    });
  return `Done. <@${slackId}> is now *${next}*.`;
};

export const COMMANDS: readonly CommandDef[] = [
  {
    name: "help",
    aliases: ["commands", "?"],
    minRole: "pal",
    usage: "",
    summary: "list the commands you can run",
    run: ({ actor }) => renderHelp(actor.role),
  },
  {
    name: "ping",
    minRole: "pal",
    usage: "",
    summary: "check I am awake",
    run: () => "pong 🏓 still here, at your service.",
  },
  {
    name: "whoami",
    minRole: "pal",
    usage: "",
    summary: "show your access level",
    run: ({ actor }) => `You are <@${actor.slackId}>, role: *${actor.role}*.`,
  },
  {
    name: "model",
    aliases: ["status"],
    minRole: "pal",
    usage: "",
    summary: "show my brain and current model",
    run: ({ deps }) => {
      const info = deps.botInfo?.();
      return info ? `I am *${info.botName}*, running on \`${info.model}\`.` : "Model info is unavailable.";
    },
  },
  {
    name: "ask",
    minRole: "pal",
    usage: "<question>",
    summary: "ask me something in one shot",
    run: async ({ deps, actor, rest }) => {
      const question = rest.trim();
      if (!question) return "Ask me something: `//ev ask <question>`";
      if (!deps.llm) return "My brain is not wired up right now.";
      const ctx = deps.promptContext?.() ?? { learnings: [] };
      const system = buildSystemPrompt({ botName: ctx.botName, base: ctx.base, learnings: ctx.learnings });
      const reply = await deps.llm.complete({
        system,
        messages: [{ role: "user", content: question }],
        assistantName: ctx.botName,
        policy: deps.toolPolicy?.(actor.role),
      });
      return reply.trim() || "I do not have anything useful to add there.";
    },
  },
  {
    name: "forget",
    minRole: "pal",
    usage: "",
    summary: "wipe my memory of this channel",
    run: ({ deps, channelId }) => {
      const removed = deps.messages.clearChannel(channelId);
      return removed > 0 ? `Forgotten. Wiped ${removed} turns from this channel.` : "Nothing to forget here.";
    },
  },
  {
    name: "users",
    aliases: ["list"],
    minRole: "admin",
    usage: "",
    summary: "list who I answer to",
    run: ({ deps }) => {
      const users = deps.users.list();
      if (users.length === 0) return "Nobody on the list yet, oddly enough.";
      return users
        .map((u) => `- <@${u.slackId}> - *${u.role}*${u.displayName ? ` (${u.displayName})` : ""}`)
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
      if (!slackId) return "Who? `//ev add @user [pal|executer|admin]`";
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
      if (!slackId) return "Who? `//ev remove @user`";
      const target = ctx.deps.users.get(slackId);
      if (!target) return "They are not on the list to begin with.";
      const err = validateRemoval(ctx.actor.role, target.role, slackId === ctx.deps.ownerSlackId);
      if (err) return err;
      ctx.deps.users.remove(slackId);
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
      return slackId ? changeRole(ctx, slackId, "admin", true) : "Who? `//ev promote @user`";
    },
  },
  {
    name: "demote",
    minRole: "owner",
    usage: "@user",
    summary: "drop someone to pal",
    run: (ctx) => {
      const slackId = slackIdOf(ctx.args[0]);
      return slackId ? changeRole(ctx, slackId, "pal", true) : "Who? `//ev demote @user`";
    },
  },
  {
    name: "learn",
    minRole: "admin",
    usage: "<fact>",
    summary: "teach me a durable fact",
    run: ({ deps, actor, rest }) => {
      if (!deps.learnings) return "Learnings are not available.";
      const fact = rest.trim();
      if (!fact) return "Teach me something: `//ev learn <fact>`";
      const l = deps.learnings.add(fact, actor.slackId, deps.clock());
      return `Learned it (#${l.id}). I will keep that in mind.`;
    },
  },
  {
    name: "learnings",
    minRole: "admin",
    usage: "",
    summary: "list what I have learned",
    run: ({ deps }) => {
      if (!deps.learnings) return "Learnings are not available.";
      const list = deps.learnings.list();
      if (list.length === 0) return "I have not learned anything yet.";
      return list.map((l) => `- #${l.id} ${l.content}`).join("\n");
    },
  },
  {
    name: "unlearn",
    minRole: "admin",
    usage: "<id>",
    summary: "make me forget a learning",
    run: ({ deps, args }) => {
      if (!deps.learnings) return "Learnings are not available.";
      const id = Number(args[0]);
      if (!Number.isInteger(id)) return "Which one? `//ev unlearn <id>` (see `//ev learnings`)";
      deps.learnings.remove(id);
      return `Forgotten learning #${id}.`;
    },
  },
  {
    name: "review",
    aliases: ["rv"],
    minRole: "pal",
    usage: "<pr-url> [pr-url...]",
    summary: "quick read-only code review of a PR",
    run: async ({ deps, actor, args }) => {
      if (args.length === 0) return "Which PR? `//ev review <pr-url>`";
      if (!deps.llm) return "My brain is not wired up right now.";
      const system = reviewPrompt(args, botNameOf(deps));
      const reply = await deps.llm.complete({
        system,
        messages: [{ role: "user", content: `review ${args.join(" ")}` }],
        assistantName: botNameOf(deps),
        policy: deps.toolPolicy?.(actor.role),
      });
      return reply.trim() || "I could not put a review together for that one.";
    },
  },
  {
    name: "bomb",
    aliases: ["br"],
    minRole: "admin",
    usage: "[category] <message-link>",
    summary: `reaction-bomb a message (${EMOJI_CATEGORY_NAMES.slice(0, 6).join(", ")}, ...)`,
    run: async ({ deps, args }) => {
      if (!deps.slack) return "Slack tools are not available.";
      // last arg is the link; an optional leading token is the category
      const link = args[args.length - 1] ?? "";
      const ref = parseMessageLink(link.replace(/^<|>$/g, ""));
      if (!ref) return "Paste a Slack message link: `//ev br [category] <message-link>`";
      const category = args.length > 1 ? (args[0] ?? "positive").toLowerCase() : "positive";
      const emojis = pickBomb(category, REACTION_BOMB_SIZE);
      if (emojis.length === 0) return `Unknown category. Try: ${EMOJI_CATEGORY_NAMES.join(", ")}`;
      const landed = await deps.slack.addReactions(ref.channel, ref.ts, emojis);
      return landed > 0 ? `💥 dropped ${landed} *${category}* reactions` : "Could not add any reactions (already bombed, or I am not in that channel).";
    },
  },
  {
    name: "reply",
    aliases: ["jrp"],
    minRole: "admin",
    usage: "<message-link>",
    summary: "draft and post an AI reply to a message",
    run: async ({ deps, args }) => {
      if (!deps.slack || !deps.draft) return "Slack tools are not available.";
      const ref = parseMessageLink((args[0] ?? "").replace(/^<|>$/g, ""));
      if (!ref) return "Paste a Slack message link: `//ev jrp <message-link>`";
      const thread = await deps.slack.replies(ref.channel, ref.ts);
      if (thread.length === 0) return "I could not read that message (am I in the channel?).";
      const draft = await deps.draft(thread);
      if (!draft.trim()) return "I could not draft a reply for that one.";
      await deps.slack.post(ref.channel, draft, ref.ts);
      return `posted a reply in that thread 🙈`;
    },
  },
];

const byName = new Map<string, CommandDef>();
for (const c of COMMANDS) {
  byName.set(c.name, c);
  for (const a of c.aliases ?? []) byName.set(a, c);
}

const renderHelp = (role: UserRole): string => {
  const lines = COMMANDS.filter((c) => RANK[role] >= RANK[c.minRole]).map(
    (c) => `- \`${c.name}${c.usage ? ` ${c.usage}` : ""}\` - ${c.summary}`,
  );
  return [
    "Commands - run either way:",
    "  slash: `/ev <command> <args>`   message: `//ev <command> <args>`",
    "",
    ...lines,
  ].join("\n");
};

/**
 * Extract the command line from an inbound message, or undefined for plain chat.
 * Accepts `//ev ...`, the legacy `!...`, and tolerates a leading @-mention.
 */
export const commandLineOf = (text: string): string | undefined => {
  const t = text.trim().replace(LEADING_MENTION, "").trim();
  if (t === "//ev" || t.toLowerCase().startsWith("//ev ")) return t.slice(4).trim();
  if (t.startsWith("!")) return t.slice(1).trim();
  return undefined;
};

/** Metadata for every command, ordered as declared - for the dashboard. */
export const listCommandInfo = (): CommandInfo[] =>
  COMMANDS.map((c) => ({
    name: c.name,
    aliases: [...(c.aliases ?? [])],
    minRole: c.minRole,
    usage: c.usage,
    summary: c.summary,
  }));

/** Run a command line (e.g. "add @U1 admin") on behalf of `actor`. */
export const dispatchCommand = async (
  deps: CommandDeps,
  actor: AllowedUser,
  channelId: string,
  line: string,
): Promise<string> => {
  const trimmed = line.trim();
  const name = (trimmed.split(/\s+/)[0] || "help").toLowerCase();
  const rest = trimmed.slice(name.length).trim();
  const args = rest.length ? rest.split(/\s+/) : [];

  const log = (command: string, ok: boolean, result: string) =>
    deps.commandLog?.add({ slackUserId: actor.slackId, command, args: rest, channelId, ok, result }, deps.clock());

  const command = byName.get(name);
  if (!command) {
    const msg = `I do not recognise \`${name}\`. Try \`//ev help\`.`;
    log(name, false, msg);
    return msg;
  }
  if (RANK[actor.role] < RANK[command.minRole]) {
    const msg = `That command needs *${command.minRole}* access. You are *${actor.role}*.`;
    log(command.name, false, msg);
    return msg;
  }
  if (command.name !== "help" && deps.disabledCommands?.().has(command.name)) {
    const msg = `\`${command.name}\` is currently disabled.`;
    log(command.name, false, msg);
    return msg;
  }
  try {
    const result = await command.run({ deps, actor, channelId, args, rest });
    log(command.name, true, result);
    return result;
  } catch (e) {
    const msg = `That command failed: ${e instanceof Error ? e.message : String(e)}`;
    log(command.name, false, msg);
    return msg;
  }
};
