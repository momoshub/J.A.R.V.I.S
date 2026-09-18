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
import {
  asAgentCap,
  DEFAULT_REVIEW_AGENTS,
  REVIEW_AGENT_CEILING,
  reviewPrompt,
} from "../domain/reviewPrompt.ts";
import {
  canRaiseTickets,
  describeRepoScope,
  parseRepoScope,
  ticketPrompt,
  type TicketSources,
} from "../domain/ticketPrompt.ts";
import {
  DENIED_LOG_SOURCES,
  LOG_SOURCES,
  logSourceOrder,
  parseLogSources,
} from "../domain/investigation.ts";
import {
  asReviewPolicy,
  DEFAULT_REVIEW_POLICY,
  repoOf,
  repoRefOf,
  type ReviewPolicy,
} from "../domain/reviewPolicy.ts";
import { BOMB_SIZE, DEFAULT_CATEGORY, parseCategories, pickBomb, renderCategories } from "../domain/emoji.ts";
import { mentionedId } from "../domain/mentions.ts";
import { parseMessageLink } from "../domain/slackLinks.ts";
import { postedBody } from "../domain/ghCommand.ts";
import { runWorkflowTurn, WORKFLOW_MIN_ROLE, type WorkflowDeps } from "./workflow.ts";
import { allowanceFor, holdForApproval, limitFor, PAL_WINDOW_MS, setLimit, type CommandLimitDeps } from "./commandLimits.ts";
import {
  encodeRequest,
  TOKEN_ACTION,
  tokenFor,
  type ClaudeTokenPort,
} from "./claudeTokens.ts";
import { tokenGuide, tokenHint, tokenWhy } from "../domain/claudeToken.ts";
import { tierOf } from "../domain/threadSession.ts";
import type { ThreadSessionRepo } from "../infrastructure/db/threadSessionRepo.ts";
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
import { modelKey, reviewPolicyKey, SETTING_KEYS, type SettingsRepo } from "../infrastructure/db/settingsRepo.ts";

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
  toolPolicy?: (role: UserRole, channelId?: string) => ToolPolicy;
  /** Per-user Claude Code tokens. `review` requires one; everything else prefers one. */
  claudeTokens?: ClaudeTokenPort;
  /** One CLI session per thread, for the `session` command to inspect and reset. */
  threadSessions?: ThreadSessionRepo;
  threadSessionsOn?: () => boolean;
  clock: Clock;
  ownerSlackId: string;
};

/** Ceiling for a relayed GitHub body in one Slack message. */
const RELAYED_BODY_CHARS = 3000;
const clip = (s: string): string =>
  s.length > RELAYED_BODY_CHARS ? `${s.slice(0, RELAYED_BODY_CHARS)}…\n(truncated - full text is on the PR)` : s;
/** review clones + spawns child agents, so allow much longer than a chat reply. */
const REVIEW_TIMEOUT_MS = 900_000;
/** a ticket reads the SOP, the thread and the code, and may open a PR. */
const TICKET_TIMEOUT_MS = 900_000;

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
const ROLES: readonly UserRole[] = ["pal", "executer", "admin", "owner"];
/** `<#C123|name>` or a bare channel id, as a channel argument can arrive either way. */
const channelRefOf = (token?: string): string | undefined => {
  const m = token?.match(/^<#([A-Z0-9]+)(?:\|[^>]*)?>$/);
  if (m?.[1]) return m[1];
  return token && /^[CDG][A-Z0-9]+$/.test(token) ? token : undefined;
};
const LEADING_MENTION = /^<@[A-Z0-9]+(?::[^>]+|\|[^>]+)?>\s*/;

/** One definition of what a mentioned user looks like, shared with the transport. */
const slackIdOf = (token?: string): string | undefined => mentionedId(token);

const roleOf = (token?: string): UserRole | undefined =>
  token === "owner" || token === "admin" || token === "executer" || token === "pal" ? token : undefined;

/** The policy a PR's repository is on, defaulting when nothing is configured. */
const reviewPolicyOf = (deps: CommandDeps, prUrl: string): ReviewPolicy => {
  const repo = repoOf(prUrl);
  if (!repo) return DEFAULT_REVIEW_POLICY;
  return asReviewPolicy(deps.settings?.get(reviewPolicyKey(repo))) ?? DEFAULT_REVIEW_POLICY;
};

/**
 * Ask someone for their own Claude Code token, with the button that opens the
 * modal. The token itself is never typed into Slack as a message: the button
 * carries only what command to resume once it is in.
 *
 * Nobody is asked twice: once the full ask has gone out it is remembered, and a
 * later attempt gets one line pointing back at the box rather than the whole
 * walkthrough again. Answering (or clearing) a token resets that.
 *
 * Returns "" when the ask was posted (the thread has it), or the text to show
 * when there is nowhere to put a button - a slash invocation, or no Slack wired
 * up at all. Either way the user is told exactly how to mint one.
 */
const askForToken = async (ctx: Context, line: string, force = false): Promise<string> => {
  const { deps, actor, channelId, threadTs, slash } = ctx;
  const ask = `🔑 <@${actor.slackId}> I need your own Claude Code token before I can run that - ${tokenWhy}\n\n${tokenGuide(slash)}`;
  if (!force && deps.claudeTokens?.asked(actor.slackId)) {
    return `🔑 still waiting on your Claude Code token - \`${slash} token\` opens the box, or use the one I sent you earlier`;
  }
  if (ctx.reply && deps.slack?.postInteractive) {
    const posted = await deps.slack
      .postInteractive(
        channelId,
        ask,
        [
          {
            actionId: TOKEN_ACTION,
            label: "Paste my token",
            value: encodeRequest({ channelId, threadTs, line }),
            style: "primary",
          },
        ],
        threadTs,
      )
      .catch(() => undefined);
    if (posted) {
      deps.claudeTokens?.markAsked(actor.slackId);
      return "";
    }
  }
  return `${ask}\n\nrun \`${slash} token\` and a box will open for it`;
};

/** Rough age of something, for a list nobody reads timestamps out of. */
const since = (ms: number): string => {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return mins <= 1 ? "just now" : `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
};

/** How many child agents a review may fan out to, defaulting when unset. */
const reviewAgentsOf = (deps: CommandDeps): number =>
  asAgentCap(deps.settings?.get(SETTING_KEYS.reviewAgents)) ?? DEFAULT_REVIEW_AGENTS;

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
    run: async ({ deps, actor, channelId, rest, prefix }) => {
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
    name: "relearn",
    aliases: ["edit-learning"],
    minRole: "admin",
    usage: "<id> <new wording>",
    summary: "reword something I have learned",
    run: ({ deps, args, rest, prefix }) => {
      if (!deps.learnings) return "Learnings are not available.";
      const id = Number(args[0]);
      if (!Number.isInteger(id)) return `Which one? \`${prefix} relearn <id> <new wording>\` (see \`${prefix} learnings\`)`;
      const content = rest.slice(String(args[0]).length).trim();
      if (!content) return `What should it say? \`${prefix} relearn ${id} <new wording>\``;
      const before = deps.learnings.list().find((l) => l.id === id);
      if (!before) return `I have no learning #${id}. Check \`${prefix} learnings\`.`;
      deps.learnings.update(id, content);
      return `Updated #${id}.\n~${before.content}~\n${content}`;
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
    name: "ticket",
    aliases: ["bug", "raise"],
    minRole: "pal",
    usage: "<what is wrong> | config [key] [value]",
    summary: "raise a properly written, correctly routed ticket",
    run: async (ctx) => {
      const { deps, actor, channelId, threadTs, args, rest, prefix, reply } = ctx;
      const get = (k: string) => deps.settings?.get(k)?.trim() || undefined;
      const sources: TicketSources = {
        tracker: get(SETTING_KEYS.ticketTracker),
        sop: get(SETTING_KEYS.ticketSop),
        pods: get(SETTING_KEYS.ticketPods),
        repoScope: parseRepoScope(get(SETTING_KEYS.ticketRepos)),
      };

      // `ticket config ...` - where the team keeps its own rules.
      if ((args[0] ?? "").toLowerCase() === "config") {
        const show = () =>
          [
            `tracker: ${sources.tracker ?? "*not set*"}`,
            `sop:     ${sources.sop ?? "*not set*"}`,
            `pods:    ${sources.pods ?? "*not set*"}`,
            `repos:   ${describeRepoScope(sources.repoScope ?? { orgs: [], repos: [] })}`,
          ].join("\n");
        if (args.length === 1) return show();
        if (RANK[actor.role] < RANK.admin) return "Only admins can change the ticket configuration.";
        const key = (args[1] ?? "").toLowerCase();
        const value = rest.slice(rest.indexOf(args[1] ?? "") + (args[1] ?? "").length).trim();
        const target = { tracker: SETTING_KEYS.ticketTracker, sop: SETTING_KEYS.ticketSop, pods: SETTING_KEYS.ticketPods, repos: SETTING_KEYS.ticketRepos }[key];
        if (!target) return `Which one? \`${prefix} ticket config <tracker|sop|pods|repos> <value>\``;
        deps.settings?.set(target, value === "default" || value === "none" ? "" : value);
        return `Set *${key}*.\n${show().replace(value, value)}`;
      }

      const report = rest.trim();
      if (!report) return `What is wrong? \`${prefix} ticket <what happened>\``;
      if (!canRaiseTickets(sources)) {
        return `No ticket tracker is configured, so I have nowhere to put it. An admin can set one: \`${prefix} ticket config tracker <notion url>\``;
      }
      if (!deps.llm) return "My brain is not wired up right now.";

      // A preset task: full access regardless of who asked, and a long timeout -
      // it reads the SOP, the thread, the code, and may open a PR.
      const full = deps.toolPolicy?.("owner") ?? { skipPermissions: true };
      const policy = { ...full, timeoutMs: TICKET_TIMEOUT_MS };
      const name = botNameOf(deps);
      const params = {
        system: ticketPrompt(report, name, sources, { channelId, threadTs, reporter: actor.slackId }, await deps.github?.whoami()),
        messages: [{ role: "user" as const, content: report }],
        assistantName: name,
        policy,
        oauthToken: tokenFor(deps, actor),
      };

      if (!reply) {
        const out = await deps.llm.complete(params);
        return out.trim() || "I could not raise that one.";
      }

      await reply(`🎫 raising a ticket for <@${actor.slackId}>`);
      let out = "";
      if (deps.llm.stream) {
        const seen = new Set<string>();
        const announce = (line: string) => {
          if (seen.has(line)) return;
          seen.add(line);
          void reply(line);
        };
        out = await deps.llm.stream(params, (ev) => {
          if (ev.type !== "tool" || ev.status !== "complete") return;
          const ran = (ev.command ?? ev.title).toLowerCase();
          if (/notion-create-pages/.test(ran)) announce("📝 created the ticket");
          if (/gh pr create\b/.test(ran)) announce("🔧 opened a PR for it");
          if (/gh pr edit[^\n]*--add-reviewer/.test(ran)) announce("👀 asked for a review");
        });
      } else {
        out = await deps.llm.complete(params);
      }
      await reply(out.trim() || "I could not raise that one.");
      return "";
    },
  },
  {
    name: "review",
    aliases: ["rv"],
    minRole: "pal",
    usage: "<pr-url> [pr-url...] [what to look at]",
    summary: "review a PR: approve it, then post the review to GitHub and here",
    run: async (ctx) => {
      const { deps, actor, args, prefix, reply } = ctx;
      if (args.length === 0) return `Which PR? \`${prefix} review <pr-url>\``;
      if (!deps.llm) return "My brain is not wired up right now.";
      // A review runs on the caller's own Claude Code credential, never the
      // bot's: it is the long, expensive job, and the usage belongs to whoever
      // asked for it. No token, no review - but the ask carries the box to put
      // one in, and the command resumes itself once it lands.
      const oauthToken = tokenFor(deps, actor);
      if (!oauthToken) {
        return deps.claudeTokens
          ? askForToken(ctx, `review ${args.join(" ")}`.trim())
          : "I have nowhere to keep a Claude Code token right now, and a review only ever runs on the caller's own. Ask an admin to check the token store.";
      }
      // Slack wraps links as <url|label>; hand the brain the bare urls.
      const urls = [...new Set(args.flatMap((a) => a.match(PR_URL) ?? []))];
      const targets = urls.length > 0 ? urls : args;
      // Anything typed alongside the urls is guidance: "the migration is the
      // risky bit", "hotfix, correctness only". It aims the review; the prompt
      // is what keeps it from doing anything more than that.
      const note = urls.length > 0 ? args.filter((a) => !PR_URL.test(a)).join(" ").trim() : "";
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
      const announcements: string[] = [];
      const approvedUpFront: string[] = [];
      // Repositories on `approve-after` are left alone until the review is in.
      const afterReview = urls.filter((u) => reviewPolicyOf(deps, u) === "approve-after");
      for (const url of urls) {
        if (afterReview.includes(url)) continue;
        const res = await deps.github?.approve(url);
        if (!res) break; // no gh wired up - leave it to the brain
        const line = res.ok ? `✅ approved ${url}` : `⚠️ could not approve ${url} - ${res.error}`;
        if (res.ok) {
          seen.add(line);
          approvedUpFront.push(url);
        }
        announcements.push(line);
      }

      const params = {
        system: reviewPrompt(targets, name, await account, approvedUpFront, reviewAgentsOf(deps), note),
        messages: [{ role: "user" as const, content: `review ${targets.join(" ")}${note ? `\n\n${note}` : ""}` }],
        assistantName: name,
        policy,
        oauthToken,
      };

      // No live destination (tests / slack off): one-shot, return the text.
      if (!reply) {
        const out = await deps.llm.complete(params);
        return out.trim() || "I could not put a review together for that one.";
      }

      // Live: post progress as each PR action lands, then the review itself. The
      // destination is chosen by the transport - thread for a message command, DM
      // for a slash command - so nothing is hidden in an ephemeral reply.
      for (const line of announcements) await reply(line);
      await reply(`🔍 reviewing ${targets.join(" ")}${note ? `\n_looking at: ${note}_` : ""}`);

      let out = "";
      // Set when the run was killed mid-flight. What streamed is then a fragment
      // of a review, never the review, and must not be presented as one.
      let cutOff = "";
      if (deps.llm.stream) {
        const announce = (line: string): void => {
          if (seen.has(line)) return;
          seen.add(line);
          void reply(line);
        };
        // Review comments posted so far, so a late follow-up is labelled as one.
        let comments = 0;
        // The only PR url we can attribute an action to when the command itself
        // carries none (e.g. `gh pr review 2149 --repo ...`).
        const soleUrl = targets.length === 1 ? (targets[0]?.match(PR_URL)?.[0] ?? "") : "";
        out = await deps.llm.stream(params, (ev) => {
          if (ev.type === "aborted") {
            cutOff = ev.reason;
            return;
          }
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
            // A second comment is the late-finding case - an agent reporting back
            // after the review went up. Say which it is rather than "the review"
            // twice, which reads as the same thing posted again.
            const what = comments++ === 0 ? "posted the review" : "posted a follow-up";
            announce(`📝 ${what}${on}${body ? `\n\n${clip(body)}` : ""}`);
          }
        });
      } else {
        out = await deps.llm.complete(params);
      }

      if (cutOff) {
        // Say it plainly. Anything that did reach GitHub was announced above as
        // it landed, so the thread already shows exactly how far this got.
        const far = out.trim();
        await reply(
          `⏱️ the review did not finish - ${cutOff}${far ? `\n\nhow far it got:\n\n${clip(far)}` : ""}`,
        );
        return "";
      }

      await reply(out.trim() || "I could not put a review together for that one.");

      // Held back until now: approve only what the review left unblocked, and
      // ask GitHub rather than inferring it from what the review seemed to say.
      for (const url of afterReview) {
        const decision = (await deps.github?.reviewDecision(url))?.toUpperCase();
        if (decision === "CHANGES_REQUESTED") {
          await reply(`🚫 not approving ${url} - changes are requested`);
          continue;
        }
        const res = await deps.github?.approve(url);
        if (!res) continue;
        await reply(res.ok ? `✅ approved ${url} - the review came back clean` : `⚠️ could not approve ${url} - ${res.error}`);
      }
      return ""; // already delivered to the thread / DM
    },
  },
  {
    name: "logsource",
    aliases: ["logsources"],
    minRole: "pal",
    usage: "[grafana,datadog|default]",
    summary: "where I look for logs, in order",
    run: (ctx) => {
      const { deps, actor, rest, prefix } = ctx;
      const describe = (order: readonly string[]) =>
        `I look for logs in this order: ${order.map((s) => `*${s}*`).join(" → ")}.\nNever: ${DENIED_LOG_SOURCES.map((s) => `*${s}*`).join(", ")} - it bills per GB scanned.`;

      const wanted = rest.trim().toLowerCase();
      if (!wanted) return describe(logSourceOrder(deps.settings?.get(SETTING_KEYS.logSources)));

      if (RANK[actor.role] < RANK.admin) return "Only admins can change where I look.";
      if (wanted === "default" || wanted === "reset") {
        deps.settings?.set(SETTING_KEYS.logSources, "");
        return describe(logSourceOrder(undefined));
      }
      // Refuse a list that mentions something unreachable rather than silently
      // dropping it - a half-applied order is worse than none.
      const asked = wanted.split(",").map((s) => s.trim()).filter(Boolean);
      const unknown = asked.filter((s) => !(s in LOG_SOURCES));
      if (unknown.length > 0 || asked.length === 0) {
        return `I do not know ${unknown.map((u) => `*${u}*`).join(", ") || "that"}. Pick from: ${Object.keys(LOG_SOURCES).join(", ")}.\n\`${prefix} logsource grafana,datadog\``;
      }
      const order = parseLogSources(asked.join(","));
      deps.settings?.set(SETTING_KEYS.logSources, order.join(","));
      return describe(order);
    },
  },
  {
    name: "review-policy",
    aliases: ["rvpolicy", "repo-policy"],
    minRole: "pal",
    usage: "[owner/repo] [first|after|default]",
    summary: "how a repo gets approved: up front, or only after a clean review",
    run: (ctx) => {
      const { deps, actor, args, prefix } = ctx;
      const describe = (p: ReviewPolicy) =>
        p === "approve-after"
          ? "approved *only after* the review, and only if nothing is blocking"
          : "approved *up front*, reversed if the review finds a blocker";

      if (args.length === 0) {
        // Configuration only says who differs; the rest are on the default.
        const configured = deps.settings
          ? deps.settings
              .list?.()
              ?.filter((e) => e.key.startsWith("review_policy:") && asReviewPolicy(e.value))
              .map((e) => `- \`${e.key.slice("review_policy:".length)}\`: ${asReviewPolicy(e.value)}`)
          : undefined;
        const list = configured && configured.length > 0 ? `\n${configured.join("\n")}` : "\nNothing configured - every repo is on the default.";
        return `Default: *${DEFAULT_REVIEW_POLICY}* - ${describe(DEFAULT_REVIEW_POLICY)}.${list}`;
      }

      const repo = repoRefOf(args[0] ?? "");
      if (!repo) return `Which repo? \`${prefix} review-policy owner/repo [first|after|default]\``;
      if (args.length === 1) {
        const own = asReviewPolicy(deps.settings?.get(reviewPolicyKey(repo)));
        return own
          ? `\`${repo}\` is on *${own}* - ${describe(own)}.`
          : `\`${repo}\` uses the default, *${DEFAULT_REVIEW_POLICY}* - ${describe(DEFAULT_REVIEW_POLICY)}.`;
      }

      if (RANK[actor.role] < RANK.admin) return "Only admins can change a review policy.";
      const want = (args[1] ?? "").toLowerCase();
      if (want === "default" || want === "reset") {
        deps.settings?.set(reviewPolicyKey(repo), "");
        return `\`${repo}\` is back on the default, *${DEFAULT_REVIEW_POLICY}*.`;
      }
      const policy: ReviewPolicy | undefined =
        want === "after" || want === "approve-after"
          ? "approve-after"
          : want === "first" || want === "approve-first"
            ? "approve-first"
            : undefined;
      if (!policy || args.length > 2) {
        return `First or after? \`${prefix} review-policy ${repo} <first|after|default>\``;
      }
      deps.settings?.set(reviewPolicyKey(repo), policy);
      return `\`${repo}\` is now *${policy}* - ${describe(policy)}.`;
    },
  },
  {
    name: "session",
    aliases: ["sess"],
    minRole: "pal",
    usage: "[reset|on|off]",
    summary: "the CLI session this thread is talking to",
    run: ({ deps, actor, channelId, threadTs, args, prefix }) => {
      const on = deps.threadSessionsOn?.() !== false;
      const want = (args[0] ?? "").toLowerCase();

      if (want === "on" || want === "off") {
        if (RANK[actor.role] < RANK.admin) return "Only admins can switch thread sessions.";
        deps.settings?.set(SETTING_KEYS.threadSessions, want === "off" ? "off" : "");
        return want === "off"
          ? "Thread sessions *off* - every turn is a cold call again, with the thread replayed into it."
          : "Thread sessions *on* - each thread keeps one session between turns.";
      }
      if (args.length > 0 && want !== "reset" && want !== "new") {
        return `\`${prefix} session [reset|on|off]\``;
      }
      if (!deps.threadSessions) return "Thread sessions are not wired up here.";
      if (!on) return "Thread sessions are *off* right now, so every turn starts cold.";
      if (!threadTs) return "That only means something inside a thread.";

      // Your own tier: what you would resume, not what someone else would.
      const tier = tierOf(deps.toolPolicy?.(actor.role, channelId));
      const bound = deps.threadSessions.find(channelId, threadTs, tier);
      if (want === "reset" || want === "new") {
        deps.threadSessions.drop(channelId, threadTs);
        return bound
          ? "Dropped it - the next message in this thread starts a fresh session with the thread read back in."
          : "Nothing bound here anyway, so the next message starts fresh.";
      }
      return bound
        ? `This thread is on one session, ${bound.turns} ${bound.turns === 1 ? "turn" : "turns"} in. \`${prefix} session reset\` starts it over.`
        : "No session bound yet - the next message in this thread opens one.";
    },
  },
  {
    name: "token",
    aliases: ["claude-token"],
    minRole: "pal",
    usage: "[remove|who]",
    summary: "your own Claude Code token, which your reviews run on",
    run: async (ctx) => {
      const { deps, actor, args, slash } = ctx;
      if (!deps.claudeTokens) return "Token storage is not wired up here.";
      const want = (args[0] ?? "").toLowerCase();

      if (want === "remove" || want === "forget" || want === "delete") {
        const had = deps.claudeTokens.get(actor.slackId);
        deps.claudeTokens.remove(actor.slackId);
        return had
          ? `Forgotten your token (${tokenHint(had)}). Your reviews will ask for a new one.`
          : "I did not have a token for you anyway.";
      }
      // Before the catch-all below, or it is never reached - which is exactly
      // what happened: `token who` answered with the usage line instead.
      if (want === "who" || want === "count" || want === "list" || want === "users") {
        if (RANK[actor.role] < RANK.admin) return "Only admins can see that.";
        const held = deps.claudeTokens.list();
        if (held.length === 0) {
          return `Nobody has given me a token yet, so nobody can run a review. \`${slash} token\` opens the box.`;
        }
        const lines = held.map((h) => {
          const name = deps.users.get(h.slackId)?.displayName;
          return `- <@${h.slackId}>${name ? ` (${name})` : ""}, added ${since(deps.clock() - h.updatedAt)}`;
        });
        return `${held.length} ${held.length === 1 ? "person has" : "people have"} given me a token. I never show one, not even to you.\n${lines.join("\n")}`;
      }
      if (args.length > 0 && want !== "add" && want !== "set") {
        return `\`${slash} token\` to add or replace one, \`${slash} token remove\` to forget it.`;
      }

      const mine = deps.claudeTokens.get(actor.slackId);
      // Never accept a token as command text: a message is readable by everyone
      // in the channel, lands in the bot's memory, and outlives the turn. The
      // box the button opens is not a message.
      const box = await askForToken(ctx, "", true);
      if (!mine) return box || "";
      return box
        ? `You already have a token on file (${tokenHint(mine)}).\n\n${box}`
        : `You already have a token on file (${tokenHint(mine)}) - the box above replaces it.`;
    },
  },
  {
    name: "review-agents",
    aliases: ["rvagents"],
    minRole: "pal",
    usage: "[n|default]",
    summary: "how many child agents one review may fan out to",
    run: (ctx) => {
      const { deps, actor, args, prefix } = ctx;
      const current = reviewAgentsOf(deps);
      const describe = (n: number) => `at most *${n}* child ${n === 1 ? "agent" : "agents"} per review`;
      if (args.length === 0) {
        const own = asAgentCap(deps.settings?.get(SETTING_KEYS.reviewAgents));
        return own
          ? `${describe(own)} (the default is ${DEFAULT_REVIEW_AGENTS}).`
          : `${describe(current)} - the default.`;
      }
      if (RANK[actor.role] < RANK.admin) return "Only admins can change the review agent cap.";
      const want = (args[0] ?? "").toLowerCase();
      if (args.length > 1) return `How many? \`${prefix} review-agents <n|default>\``;
      if (want === "default" || want === "reset") {
        deps.settings?.remove(SETTING_KEYS.reviewAgents);
        return `Back on the default, ${describe(DEFAULT_REVIEW_AGENTS)}.`;
      }
      const n = asAgentCap(want);
      if (!n) return `A number from 1 to ${REVIEW_AGENT_CEILING}, or \`default\`.`;
      deps.settings?.set(SETTING_KEYS.reviewAgents, String(n));
      return `Reviews now spawn ${describe(n)}.`;
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
