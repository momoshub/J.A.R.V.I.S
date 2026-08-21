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
import { BOMB_SIZE, DEFAULT_CATEGORY, parseCategories, pickBomb, renderCategories } from "../domain/emoji.ts";
import { parseMessageLink } from "../domain/slackLinks.ts";
import { postedBody } from "../domain/ghCommand.ts";
import { runWorkflowTurn, WORKFLOW_MIN_ROLE, type WorkflowDeps } from "./workflow.ts";
import { allowanceFor, holdForApproval, limitFor, PAL_WINDOW_MS, setLimit, type CommandLimitDeps } from "./commandLimits.ts";
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
import type { WorkflowRepo } from "../infrastructure/db/workflowRepo.ts";
import type { CommandApprovalRepo } from "../infrastructure/db/commandApprovalRepo.ts";
import type { SettingsRepo } from "../infrastructure/db/settingsRepo.ts";

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
  /** Long-running workflow sessions bound to a thread. */
  workflows?: WorkflowRepo;
  /** Fresh CLI session id for a new workflow; injected for deterministic tests. */
  newSessionId?: () => string;
  /** Commands parked for approval once a limited role runs out of allowance. */
  commandApprovals?: CommandApprovalRepo;
  /** Settings, for per-person command allowances. */
  settings?: SettingsRepo;
  /** AI reply drafting, for reply. */
  draft?: DraftReply;
  /** Per-role CLI tool policy (sandbox/allow-list), for ask + review. */
  toolPolicy?: (role: UserRole) => ToolPolicy;
  clock: Clock;
  ownerSlackId: string;
};

/** Ceiling for a relayed GitHub body in one Slack message. */
const RELAYED_BODY_CHARS = 3000;
const clip = (s: string): string =>
  s.length > RELAYED_BODY_CHARS ? `${s.slice(0, RELAYED_BODY_CHARS)}…\n(truncated - full text is on the PR)` : s;
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
  /** Thread the command was typed in; absent when invoked by slash command. */
  threadTs?: string;
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
  /**
   * Skip the owner's copy of a slash invocation. Set on commands that do
   * nothing and reveal nothing - mirroring a `ping` is pure noise.
   */
  trivial?: boolean;
  run: (ctx: Context) => string | Promise<string>;
};

const RANK: Record<UserRole, number> = { pal: 0, executer: 1, admin: 2, owner: 3 };
/** Roles an allowance applies to; mirrors LIMITED_ROLES without the import cycle. */
const LIMITED: readonly UserRole[] = ["pal"];
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
    trivial: true,
    aliases: ["commands", "?"],
    minRole: "pal",
    usage: "",
    summary: "list the commands you can run",
    run: ({ actor, prefix, slash }) => renderHelp(actor.role, prefix, slash),
  },
  {
    name: "ping",
    trivial: true,
    minRole: "pal",
    usage: "",
    summary: "check I am awake",
    run: () => "pong 🏓 still here, at your service.",
  },
  {
    name: "whoami",
    trivial: true,
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

      // Who the comment is written as. In flight while we approve - the brain
      // needs it in its prompt, and it would otherwise spend a tool call on it.
      const account = deps.github?.whoami();

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

      const params = {
        system: reviewPrompt(targets, name, await account),
        messages: [{ role: "user" as const, content: `review ${targets.join(" ")}` }],
        assistantName: name,
        policy,
      };

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
          // The change request carries a fixed marker, so there is nothing to
          // relay; the comment is where the review is written, and it comes with
          // the body that went to GitHub, recovered from the command itself.
          if (/gh pr review[^\n]*--request-changes/.test(t)) announce(`⚠️ requested changes${on}`);
          if (/gh pr comment\b/.test(t)) {
            const body = postedBody(ran, "comment");
            announce(`📝 posted the review${on}${body ? `\n\n${clip(body)}` : ""}`);
          }
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
    usage: "[categories] [count] <message-link> | help",
    summary: `reaction-bomb a message (combine categories with commas; \`bomb help\` lists them)`,
    run: async ({ deps, args, prefix }) => {
      const usage = `\`${prefix} bomb [categories] [count] <message-link>\`
Combine with commas and set a count, e.g. \`${prefix} bomb money,face,negative 9 <link>\`
Up to ${BOMB_SIZE} reactions; no category means *${DEFAULT_CATEGORY}*.`;
      if (args.length === 1 && /^(help|\?|list|categories)$/i.test(args[0] ?? "")) {
        return `${usage}\n\n${renderCategories()}`;
      }
      if (!deps.slack) return "Slack tools are not available.";

      // Last arg is the link; the tokens before it are the category list and an
      // optional count, in either order - a bare number can only be the count.
      const link = args[args.length - 1] ?? "";
      const ref = parseMessageLink(link.replace(/^<|>$/g, ""));
      if (!ref) return `Paste a Slack message link:\n${usage}`;

      let count = BOMB_SIZE;
      let categories = [DEFAULT_CATEGORY];
      for (const token of args.slice(0, -1)) {
        if (/^\d+$/.test(token)) count = Math.min(Math.max(Number(token), 1), BOMB_SIZE);
        else categories = parseCategories(token);
      }

      const { emojis, used, unknown } = pickBomb(categories, count);
      if (emojis.length === 0) {
        return `No emoji for ${unknown.map((u) => `*${u}*`).join(", ") || "that"}.\n\n${renderCategories()}`;
      }
      const landed = await deps.slack.addReactions(ref.channel, ref.ts, emojis);
      if (landed === 0) return "Could not add any reactions (already bombed, or I am not in that channel).";
      const skipped = unknown.length > 0 ? ` (no such category: ${unknown.join(", ")})` : "";
      const short = landed < count ? `, ${count - landed} did not stick` : "";
      return `💥 dropped ${landed} *${used.join(", ")}* reactions${short}${skipped}`;
    },
  },
  {
    name: "limit",
    aliases: ["quota"],
    minRole: "pal",
    usage: "[@user] [n|default]",
    summary: "show command allowance; admins can set someone's",
    run: (ctx) => {
      const { deps, actor, args, prefix } = ctx;
      const window = Math.round(PAL_WINDOW_MS / 3_600_000);
      const report = (id: string): string => {
        const target = deps.users.get(id);
        if (!target) return "I do not know that user.";
        const allowance = allowanceFor(deps as CommandLimitDeps, target, TRIVIAL_COMMANDS);
        if (!LIMITED.includes(target.role)) return `<@${id}> is *${target.role}* - no allowance applies.`;
        return `<@${id}>: ${allowance.used}/${allowance.limit} commands used in the last ${window}h.`;
      };

      const slackId = slackIdOf(args[0]);
      // No target: your own standing.
      if (!slackId) return report(actor.slackId);
      if (args.length === 1) {
        if (RANK[actor.role] < RANK.admin && slackId !== actor.slackId) {
          return "Only admins can look up someone else's allowance.";
        }
        return report(slackId);
      }

      if (RANK[actor.role] < RANK.admin) return "Only admins can change an allowance.";
      const raw = (args[1] ?? "").toLowerCase();
      if (raw === "default" || raw === "reset") {
        setLimit(deps as CommandLimitDeps, slackId, undefined);
        return `<@${slackId}> is back on the default allowance (${limitFor(deps as CommandLimitDeps, slackId)} per ${window}h).`;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) return `How many? \`${prefix} limit @user <number|default>\``;
      setLimit(deps as CommandLimitDeps, slackId, n);
      return n === 0
        ? `<@${slackId}> now needs approval for every command.`
        : `<@${slackId}> can now run *${n}* commands per ${window}h.`;
    },
  },
  {
    name: "workflow",
    aliases: ["wf"],
    minRole: WORKFLOW_MIN_ROLE,
    usage: "<task> | stop | status",
    summary: "start a long task in this thread and keep talking to it",
    run: async (ctx) => {
      const { deps, actor, channelId, threadTs, rest, prefix, reply } = ctx;
      if (!deps.workflows) return "Workflows are not available.";
      if (!threadTs) {
        return `Workflows live in a thread - use \`${prefix} workflow <task>\` in a channel or DM rather than the slash command.`;
      }
      const live = deps.workflows.activeFor(channelId, threadTs);
      const sub = rest.trim();

      if (/^stop$/i.test(sub)) {
        if (!live) return "No workflow running in this thread.";
        deps.workflows.stop(live.id, deps.clock());
        return `🛑 workflow stopped after ${live.turns} turn${live.turns === 1 ? "" : "s"}. The thread goes back to normal chat.`;
      }
      if (/^status$/i.test(sub)) {
        if (!live) return "No workflow running in this thread.";
        return `⚙️ workflow running - started by <@${live.startedBy}>, ${live.turns} turn${live.turns === 1 ? "" : "s"} so far.\n> ${live.task}`;
      }
      if (live) {
        return `A workflow is already running in this thread (${live.turns} turns). Just talk to it, or \`${prefix} workflow stop\` to end it.`;
      }
      if (!sub) return `What should I work on? \`${prefix} workflow <task>\``;
      if (!deps.llm) return "My brain is not wired up right now.";

      const workflow = deps.workflows.start(
        {
          channelId,
          threadTs,
          sessionId: (deps.newSessionId ?? (() => crypto.randomUUID()))(),
          task: sub,
          startedBy: actor.slackId,
        },
        deps.clock(),
      );

      // No live destination (tests / slack off): run the turn and return it.
      if (!reply) return runWorkflowTurn(deps as WorkflowDeps, workflow, actor, sub, true);

      await reply(`⚙️ workflow started - I will keep this session open. Talk to me here; \`${prefix} workflow stop\` ends it.`);
      const out = await runWorkflowTurn(deps as WorkflowDeps, workflow, actor, sub, true);
      await reply(out);
      return ""; // already delivered to the thread
    },
  },
  {
    name: "rm-msg",
    aliases: ["rmmsg", "unsend"],
    minRole: "admin",
    usage: "<message-link>",
    summary: "delete a message I posted",
    run: async ({ deps, args, prefix }) => {
      if (!deps.slack) return "Slack tools are not available.";
      const ref = parseMessageLink((args[0] ?? "").replace(/^<|>$/g, ""));
      if (!ref) return `Paste a Slack message link: \`${prefix} rm-msg <message-link>\``;
      try {
        await deps.slack.remove(ref.channel, ref.ts);
        return "🗑️ deleted that one";
      } catch (e) {
        // A bot token may only delete what the bot itself posted, so the usual
        // failure is someone else's message rather than anything being wrong.
        const err = e instanceof Error ? e.message : String(e);
        if (/cant_delete_message|message_not_found/.test(err)) {
          return "I can only delete messages I posted myself - that one is not mine (or is already gone).";
        }
        return `Could not delete it: ${err}`;
      }
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

/**
 * Whether a slash invocation of this line is worth copying to the owner.
 * Unknown commands count: a failed guess is still something worth seeing.
 */
/** Commands that cost nothing and so do not count against an allowance. */
export const TRIVIAL_COMMANDS: readonly string[] = COMMANDS.filter((c) => c.trivial).map((c) => c.name);

export const notifiesOwner = (line: string): boolean => {
  const name = (line.trim().split(/\s+/)[0] || "help").toLowerCase();
  return byName.get(name)?.trivial !== true;
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
  /** Thread the command came from; workflows are bound to one. */
  threadTs?: string;
  /** Already approved by someone with authority - skip the allowance check. */
  preApproved?: boolean;
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
  // A limited role that has run out is not turned away - the command is parked
  // and put to the owner. Trivial commands never count and are never held.
  if (!command.trivial && !opts.preApproved) {
    const allowance = allowanceFor(deps as CommandLimitDeps, actor, TRIVIAL_COMMANDS);
    if (allowance.limited) {
      const msg = await holdForApproval(
        deps as CommandLimitDeps,
        actor,
        trimmed,
        channelId,
        opts.threadTs,
        allowance,
      );
      log(command.name, false, msg);
      return msg;
    }
  }
  try {
    const result = await command.run({
      deps,
      actor,
      channelId,
      threadTs: opts.threadTs,
      args,
      rest,
      prefix,
      slash,
      reply: opts.reply,
    });
    log(command.name, true, result);
    return result;
  } catch (e) {
    const msg = `That command failed: ${e instanceof Error ? e.message : String(e)}`;
    log(command.name, false, msg);
    return msg;
  }
};
