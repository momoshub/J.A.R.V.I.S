/**
 * Command layer.
 *
 * A single registry of predefined commands, each invokable two ways:
 *   - Slack slash command:  `<slash> <name> <args...>`   (one registration, sub-routed)
 *   - Template message:      `<prefix> <name> <args...>`  (or the legacy `!<name>`)
 *
 * Both the message prefix and the slash name are configured at the edge (env);
 * nothing here hardcodes them beyond neutral fallbacks. Both interfaces resolve
 * to the same line via `commandLineOf` and run through `dispatchCommand`, which
 * enforces per-command role gates before touching repos or the brain.
 */
import { buildSystemPrompt, DEFAULT_BOT_NAME } from "../domain/personality.ts";
import { validateRemoval, validateRoleChange } from "../domain/access.ts";
import { reviewPrompt } from "../domain/reviewPrompt.ts";
import { EMOJI_CATEGORY_NAMES, pickBomb } from "../domain/emoji.ts";
import { parseMessageLink } from "../domain/slackLinks.ts";
import type { AllowedUser, PromptContext, UserRole } from "../domain/types.ts";
import type { ToolPolicy } from "../domain/toolPolicy.ts";
import type { Clock, LlmPort } from "./ports.ts";
import type { SlackAdminPort } from "./slackAdmin.ts";
import type { GitHubPort } from "./github.ts";
import type { DraftReply } from "./draftReply.ts";
import type { MessageRepo } from "../infrastructure/db/messageRepo.ts";
import type { UserRepo } from "../infrastructure/db/userRepo.ts";
import type { LearningsRepo } from "../infrastructure/db/learningsRepo.ts";
import type { CommandLogRepo } from "../infrastructure/db/commandLogRepo.ts";

/** Neutral fallbacks; the real prefix/slash come from config (see index.ts). */
export const DEFAULT_COMMAND_PREFIX = "//bot";
export const DEFAULT_SLASH_COMMAND = "/bot";

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
  /** Slack Web API operations, for the power tools (bomb, reply). */
  slack?: SlackAdminPort;
  /** GitHub actions the bot takes itself - the up-front approve in `review`. */
  github?: GitHubPort;
  /** AI reply drafting, for reply. */
  draft?: DraftReply;
  /** Per-role CLI tool policy (sandbox/allow-list), for ask + review. */
  toolPolicy?: (role: UserRole) => ToolPolicy;
  clock: Clock;
  ownerSlackId: string;
};

const REACTION_BOMB_SIZE = 23;
/** review clones + spawns child agents, so allow much longer than a chat reply. */
const REVIEW_TIMEOUT_MS = 600_000;

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
  /** configured message prefix + slash, for help/hint text */
  prefix: string;
  slash: string;
  /**
   * Post a visible message to the invocation's destination (the thread for a
   * message command, a DM for a slash command). Present only when a transport
   * wired it in; long-running commands (review) use it to stream progress and
   * post the result directly instead of returning one blob. Undefined in tests.
   */
  reply?: (text: string) => Promise<void>;
};

/** A github PR url, for pulling the target out of a tool-call title. */
const PR_URL = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

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
  deps.botInfo?.().botName ?? deps.promptContext?.().botName ?? DEFAULT_BOT_NAME;

const changeRole = (ctx: Context, slackId: string, next: UserRole, requireExisting: boolean): string => {
  const target = ctx.deps.users.get(slackId);
  if (requireExisting && !target) return "I do not know that user - add them first.";
  const err = validateRoleChange(ctx.actor.role, target?.role ?? "pal", next, slackId === ctx.deps.ownerSlackId);
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
    run: ({ actor, prefix, slash }) => renderHelp(actor.role, prefix, slash),
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
    run: async ({ deps, actor, rest, prefix }) => {
      const question = rest.trim();
      if (!question) return `Ask me something: \`${prefix} ask <question>\``;
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
  {
    name: "learn",
    minRole: "admin",
    usage: "<fact>",
    summary: "teach me a durable fact",
    run: ({ deps, actor, rest, prefix }) => {
      if (!deps.learnings) return "Learnings are not available.";
      const fact = rest.trim();
      if (!fact) return `Teach me something: \`${prefix} learn <fact>\``;
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
    run: ({ deps, args, prefix }) => {
      if (!deps.learnings) return "Learnings are not available.";
      const id = Number(args[0]);
      if (!Number.isInteger(id)) return `Which one? \`${prefix} unlearn <id>\` (see \`${prefix} learnings\`)`;
      deps.learnings.remove(id);
      return `Forgotten learning #${id}.`;
    },
  },
  {
    name: "review",
    aliases: ["rv"],
    minRole: "pal",
    usage: "<pr-url> [pr-url...]",
    summary: "review a PR: approve it, then post the review to GitHub and here",
    run: async ({ deps, args, prefix, reply }) => {
      if (args.length === 0) return `Which PR? \`${prefix} review <pr-url>\``;
      if (!deps.llm) return "My brain is not wired up right now.";
      // Slack wraps links as <url|label>; hand the brain the bare urls.
      const urls = [...new Set(args.flatMap((a) => a.match(PR_URL) ?? []))];
      const targets = urls.length > 0 ? urls : args;
      // A preset, tightly-scoped task: always run FULL access (it comments and
      // requests changes on GitHub, clones, and spawns child agents) with a long
      // timeout, regardless of the caller's role.
      const full = deps.toolPolicy?.("owner") ?? { skipPermissions: true };
      const policy = { ...full, timeoutMs: REVIEW_TIMEOUT_MS };
      const name = botNameOf(deps);
      const params = {
        system: reviewPrompt(targets, name),
        messages: [{ role: "user" as const, content: `review ${targets.join(" ")}` }],
        assistantName: name,
        policy,
      };

      // Approve FIRST, in code, before the brain is even spawned. It is a fixed
      // step, not a judgement call, so it must not wait ~30s for the model to read
      // the PR. `seen` carries the lines forward so the brain cannot repeat them.
      const seen = new Set<string>();
      const approved: string[] = [];
      for (const url of urls) {
        const res = await deps.github?.approve(url);
        if (!res) break; // no gh wired up - leave it to the brain
        const line = res.ok ? `✅ approved ${url}` : `⚠️ could not approve ${url} - ${res.error}`;
        if (res.ok) seen.add(line);
        approved.push(line);
      }

      // No live destination (tests / slack off): one-shot, return the text.
      if (!reply) {
        const out = await deps.llm.complete(params);
        return out.trim() || "I could not put a review together for that one.";
      }

      // Live: post progress as each PR action lands, then the review itself. The
      // destination is chosen by the transport - thread for a message command, DM
      // for a slash command - so nothing is hidden in an ephemeral reply.
      for (const line of approved) await reply(line);
      await reply(`🔍 reviewing ${targets.join(" ")}`);

      let out = "";
      if (deps.llm.stream) {
        const announce = (line: string): void => {
          if (seen.has(line)) return;
          seen.add(line);
          void reply(line);
        };
        // The only PR url we can attribute an action to when the command itself
        // carries none (e.g. `gh pr review 2149 --repo ...`).
        const soleUrl = targets.length === 1 ? (targets[0]?.match(PR_URL)?.[0] ?? "") : "";
        out = await deps.llm.stream(params, (ev) => {
          if (ev.type !== "tool" || ev.status !== "complete") return;
          // Match the command in full, never the card title: the title is clipped
          // at 200 chars, and a `gh pr review` written after a heredoc body sits
          // well past that - which is how a request-changes went unannounced.
          const ran = ev.command ?? ev.title;
          const t = ran.toLowerCase();
          const url = ran.match(PR_URL)?.[0] ?? soleUrl;
          const at = url ? ` ${url}` : "";
          const on = url ? ` on ${url}` : "";
          // Independent, not else-if: one shell call can approve and then reverse.
          // `[^\n]*` keeps a match on the gh line itself, so prose inside a heredoc
          // body ("flipping back to request-changes") cannot trigger a false line.
          if (/gh pr review[^\n]*--approve/.test(t)) announce(`✅ approved${at}`);
          if (/gh pr review[^\n]*--request-changes/.test(t)) announce(`⚠️ requested changes${on}`);
          if (/gh pr comment\b/.test(t)) announce(`📝 posted the review${on}`);
        });
      } else {
        out = await deps.llm.complete(params);
      }

      await reply(out.trim() || "I could not put a review together for that one.");
      return ""; // already delivered to the thread / DM
    },
  },
  {
    name: "bomb",
    aliases: ["br"],
    minRole: "admin",
    usage: "[category] <message-link>",
    summary: `reaction-bomb a message (${EMOJI_CATEGORY_NAMES.slice(0, 6).join(", ")}, ...)`,
    run: async ({ deps, args, prefix }) => {
      if (!deps.slack) return "Slack tools are not available.";
      // last arg is the link; an optional leading token is the category
      const link = args[args.length - 1] ?? "";
      const ref = parseMessageLink(link.replace(/^<|>$/g, ""));
      if (!ref) return `Paste a Slack message link: \`${prefix} bomb [category] <message-link>\``;
      const category = args.length > 1 ? (args[0] ?? "positive").toLowerCase() : "positive";
      const emojis = pickBomb(category, REACTION_BOMB_SIZE);
      if (emojis.length === 0) return `Unknown category. Try: ${EMOJI_CATEGORY_NAMES.join(", ")}`;
      const landed = await deps.slack.addReactions(ref.channel, ref.ts, emojis);
      return landed > 0
        ? `💥 dropped ${landed} *${category}* reactions`
        : "Could not add any reactions (already bombed, or I am not in that channel).";
    },
  },
  {
    name: "reply",
    aliases: ["jrp"],
    minRole: "admin",
    usage: "<message-link>",
    summary: "draft and post an AI reply to a message",
    run: async ({ deps, args, prefix }) => {
      if (!deps.slack || !deps.draft) return "Slack tools are not available.";
      const ref = parseMessageLink((args[0] ?? "").replace(/^<|>$/g, ""));
      if (!ref) return `Paste a Slack message link: \`${prefix} reply <message-link>\``;
      const thread = await deps.slack.replies(ref.channel, ref.ts);
      if (thread.length === 0) return "I could not read that message (am I in the channel?).";
      const draft = await deps.draft(thread);
      if (!draft.trim()) return "I could not draft a reply for that one.";
      await deps.slack.post(ref.channel, draft, ref.ts);
      return "posted a reply in that thread 🙈";
    },
  },
];

const byName = new Map<string, CommandDef>();
for (const c of COMMANDS) {
  byName.set(c.name, c);
  for (const a of c.aliases ?? []) byName.set(a, c);
}

const renderHelp = (role: UserRole, prefix: string, slash: string): string => {
  const lines = COMMANDS.filter((c) => RANK[role] >= RANK[c.minRole]).map(
    (c) => `- \`${c.name}${c.usage ? ` ${c.usage}` : ""}\` - ${c.summary}`,
  );
  return [
    "Commands - run either way:",
    `  slash: \`${slash} <command> <args>\`   message: \`${prefix} <command> <args>\``,
    "",
    ...lines,
  ].join("\n");
};

/**
 * Extract the command line from an inbound message, or undefined for plain chat.
 * Accepts the configured `prefix`, the legacy `!`, and tolerates a leading mention.
 */
export const commandLineOf = (text: string, prefix: string = DEFAULT_COMMAND_PREFIX): string | undefined => {
  const t = text.trim().replace(LEADING_MENTION, "").trim();
  const p = prefix.trim();
  const lower = t.toLowerCase();
  if (t === p || lower.startsWith(`${p.toLowerCase()} `)) return t.slice(p.length).trim();
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

export type DispatchOptions = {
  prefix?: string;
  slash?: string;
  /** Destination sink for progress + direct results (thread or DM). */
  reply?: (text: string) => Promise<void>;
};

/** Run a command line (e.g. "add @U1 admin") on behalf of `actor`. */
export const dispatchCommand = async (
  deps: CommandDeps,
  actor: AllowedUser,
  channelId: string,
  line: string,
  opts: DispatchOptions = {},
): Promise<string> => {
  const prefix = opts.prefix ?? DEFAULT_COMMAND_PREFIX;
  const slash = opts.slash ?? DEFAULT_SLASH_COMMAND;
  const trimmed = line.trim();
  const name = (trimmed.split(/\s+/)[0] || "help").toLowerCase();
  const rest = trimmed.slice(name.length).trim();
  const args = rest.length ? rest.split(/\s+/) : [];

  const log = (command: string, ok: boolean, result: string) =>
    deps.commandLog?.add({ slackUserId: actor.slackId, command, args: rest, channelId, ok, result }, deps.clock());

  const command = byName.get(name);
  if (!command) {
    const msg = `I do not recognise \`${name}\`. Try \`${prefix} help\`.`;
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
    const result = await command.run({ deps, actor, channelId, args, rest, prefix, slash, reply: opts.reply });
    log(command.name, true, result);
    return result;
  } catch (e) {
    const msg = `That command failed: ${e instanceof Error ? e.message : String(e)}`;
    log(command.name, false, msg);
    return msg;
  }
};
