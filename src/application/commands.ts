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
import { refinePrompt } from "../domain/refinePrompt.ts";
import { notePrompt } from "../domain/notePrompt.ts";
import { closePrompt } from "../domain/closePrompt.ts";
import { adapterRules, isBlank } from "../domain/adapter.ts";
import { ALWAYS_ON_BUDGET, describeCheck } from "../domain/adapterCheck.ts";
import {
  type AdapterDeps,
  adapterStatus,
  commitAdapter,
  migrateLearnings,
  rememberFact,
  revertAdapter,
} from "./adapterMemory.ts";
import { describeSystem, trendOf } from "../domain/systemStatus.ts";
import {
  buildCommandMenu,
  MENU_SELECT_ACTION,
  menuPrompt,
  menuRunActionId,
} from "../domain/commandMenu.ts";
import type { SystemTracker } from "../infrastructure/system/systemProbe.ts";
import type { AdapterStore } from "../infrastructure/adapter/adapterStore.ts";
import type { AdapterRevisionRepo } from "../infrastructure/db/adapterRevisionRepo.ts";
import { validateRemoval, validateRoleChange } from "../domain/access.ts";
import {
  asAgentCap,
  DEFAULT_REVIEW_AGENTS,
  REVIEW_AGENT_CEILING,
  reviewHelp,
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
import { investigatePrompt } from "../domain/investigatePrompt.ts";
import { fanoutPrompt } from "../domain/fanoutPrompt.ts";
import { readPrompt } from "../domain/readPrompt.ts";
import {
  asReviewPolicy,
  authorRefOf,
  DEFAULT_REVIEW_POLICY,
  looksLikePrRef,
  parsePolicyArg,
  stricterPolicy,
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
import {
  encodeTotpRequest,
  TOTP_ACTION,
  type TotpPort,
} from "./totp.ts";
import { normaliseLabel, secondsLeft, totpCode } from "../domain/totp.ts";
import { isAuthFailure, isTimeout, tierOf } from "../domain/threadSession.ts";
import { asksForHelp, commandHelp } from "../domain/commandHelp.ts";
import { nearestCommand } from "../domain/commandSuggest.ts";
import { forHowLong, stillStoppingNotice, stoppedNotice } from "../domain/runControl.ts";
import type { RunRegistry } from "./runRegistry.ts";
import type { ThreadSessionRepo } from "../infrastructure/db/threadSessionRepo.ts";
import type { AllowedUser, PromptContext, UserRole } from "../domain/types.ts";
import { NO_TOOLS, type ToolPolicy } from "../domain/toolPolicy.ts";
import { btwRules } from "../domain/btwPrompt.ts";
import { parseNoteArgs } from "../domain/noteTarget.ts";
import { buildContextWindow } from "../domain/conversation.ts";
import type { Clock, LlmPort } from "./ports.ts";
import type { SlackAdminPort } from "./slackAdmin.ts";
import type { GitHubPort } from "./github.ts";
import type { DraftReply } from "./draftReply.ts";
import type { MessageRepo } from "../infrastructure/db/messageRepo.ts";
import type { UserRepo } from "../infrastructure/db/userRepo.ts";
import type { LearningsRepo } from "../infrastructure/db/learningsRepo.ts";
import type { CommandLogRepo } from "../infrastructure/db/commandLogRepo.ts";
import type { UsageRepo } from "../infrastructure/db/usageRepo.ts";
import type { TurnLogRepo } from "../infrastructure/db/turnLogRepo.ts";
import type { WatchRepo } from "../infrastructure/db/watchRepo.ts";
import type { FollowRepo } from "../infrastructure/db/followRepo.ts";
import { builtinCheck, humanDuration, parseWatchArgs } from "../domain/watch.ts";
import { DEFAULT_SNUB_REPLY, formatSnubbed, parseSnubbed } from "../domain/snub.ts";
import {
  mindfulReport,
  teamFromPermalink,
  type LiveRun,
  type MindfulView,
} from "../domain/mindful.ts";
import { spendReport } from "../domain/spendReport.ts";
import type { WorkflowRepo } from "../infrastructure/db/workflowRepo.ts";
import type { CommandApprovalRepo } from "../infrastructure/db/commandApprovalRepo.ts";
import { authorReviewPolicyKey, modelKey, reviewPolicyKey, SETTING_KEYS, type SettingsRepo } from "../infrastructure/db/settingsRepo.ts";

/** Neutral fallbacks; the real prefix/slash come from config (see index.ts). */
export const DEFAULT_COMMAND_PREFIX = "//bot";
export const DEFAULT_SLASH_COMMAND = "/bot";

export type CommandDeps = {
  users: UserRepo;
  messages: MessageRepo;
  learnings?: LearningsRepo;
  /** The memory adapter directory; when set, it replaces the learnings list. */
  adapterStore?: AdapterStore;
  adapterRevisions?: AdapterRevisionRepo;
  /** Always-on byte ceiling; the default lives in `adapterCheck`. */
  adapterBudget?: () => number;
  /** Host and process vitals, sampled over time. */
  system?: SystemTracker;
  /** Absolute path of the claude.ai artifact reader, for `read`. */
  artifactScript?: string;
  /** Absolute path of the "has anything new been said" helper, for `watch reply`. */
  slackWaitScript?: string;
  llm?: LlmPort;
  promptContext?: () => PromptContext;
  botInfo?: () => { botName: string; model: string };
  commandLog?: CommandLogRepo;
  /** Names of disabled commands (managed from the dashboard). */
  disabledCommands?: () => ReadonlySet<string>;
  /** What each run of the model consumed, for `spend` and the dashboard. */
  usage?: UsageRepo;
  /** How each turn ended, for `mindful` and for continuing a failed thread. */
  turns?: TurnLogRepo;
  /** Things the bot is waiting for, polled outside any turn. */
  watches?: WatchRepo;
  /** Threads it was asked to keep up with, tag or no tag. */
  follows?: FollowRepo;
  /** The workspace domain, so `mindful` can print clickable thread links. */
  slackTeam?: () => string | undefined;
  /**
   * Run a chat turn in a thread, as somebody, from outside the Slack handler.
   * Wired at the composition root for the same reason `runCommand` is: the
   * full respond path lives above this module, and `mindful continue` needs
   * exactly it - re-running a dead turn with its own session and thread.
   */
  runTurn?: (req: {
    channelId: string;
    threadTs: string;
    slackUserId: string;
    text: string;
  }) => Promise<void>;
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
  /** Shared 2FA setup keys, for the `2fa` command. */
  totp?: TotpPort;
  /** In-flight turns, so `stop` can end one without waiting it out. */
  runs?: RunRegistry;
  /** Read-only Grafana helper, so an investigation can reach a non-Loki datasource. */
  grafanaGetScript?: string;
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
/** A refine pass reads every file and rewrites most of them. */
const REFINE_TIMEOUT_MS = 900_000;
/** Publishing reads a file and builds a page; it is not a research task. */
const NOTE_TIMEOUT_MS = 300_000;
/** Closing reads the page and the tracker schema, then sets one property. */
const CLOSE_TIMEOUT_MS = 300_000;
/** an investigation walks logs, RUM and traces across environments. */
const INVESTIGATE_TIMEOUT_MS = 900_000;
/** a fanout waits on several agents doing real coding work. */
const FANOUT_TIMEOUT_MS = 2_700_000;
/** reading a conversation is bounded work, but a busy channel is a lot of it. */
const READ_TIMEOUT_MS = 600_000;
/**
 * A side question has no tools and is told to answer in two sentences, so it
 * is over in seconds. A minute is already generous, and the point of the
 * command is that it comes back while the real work is still going.
 */
const BTW_TIMEOUT_MS = 90_000;
/** How much of the thread a side question is shown. Context, not a transcript. */
const BTW_WINDOW = 12;

/** Public metadata for one command, for the dashboard. */
export type CommandInfo = {
  name: string;
  aliases: string[];
  minRole: UserRole;
  usage: string;
  summary: string;
  /** Destroys something; the menu confirms before running it. */
  destructive?: boolean;
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
  /**
   * A command the brain uses as a TOOL rather than an errand: it hands the
   * result back to the caller instead of posting it, and the caller waits for
   * it. Typed by a person it still answers in the thread as usual - the
   * difference is only in who asked and what they do with the answer.
   */
  quiet?: boolean;
  /**
   * Destroys something, so the menu will not make it a one-tap button and
   * confirms before running it. Typing it stays as direct as it ever was -
   * this is about a stray press, not about second-guessing the command.
   */
  destructive?: boolean;
  /**
   * This command answers `help` itself, and better than the generic card can
   * (`review help` explains the whole flow, and `review prompt` prints the
   * real system prompt). Everything else gets the card.
   */
  ownHelp?: boolean;
  run: (ctx: Context) => string | Promise<string>;
};

/** The adapter use-case bag, or undefined when no adapter is configured. */
const adapterDepsOf = (deps: CommandDeps): AdapterDeps | undefined =>
  deps.adapterStore?.exists()
    ? {
        store: deps.adapterStore,
        revisions: deps.adapterRevisions,
        clock: deps.clock,
        budget: deps.adapterBudget?.() ?? ALWAYS_ON_BUDGET,
      }
    : undefined;

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

/**
 * `24h`, `7d`, `90m`, or a bare number of hours. Undefined when it is not a
 * window at all, so the caller can fall back rather than reporting on zero.
 */
export const parseWindow = (token?: string): number | undefined => {
  const t = (token ?? "").trim().toLowerCase();
  if (!t) return undefined;
  const m = t.match(/^(\d+(?:\.\d+)?)\s*([mhdw])?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = m[2] ?? "h";
  const ms = unit === "m" ? 60_000 : unit === "d" ? 86_400_000 : unit === "w" ? 7 * 86_400_000 : 3_600_000;
  return n * ms;
};

/** The policy a PR's repository is on, defaulting when nothing is configured. */
const repoPolicyOf = (deps: CommandDeps, prUrl: string): ReviewPolicy => {
  const repo = repoOf(prUrl);
  if (!repo) return DEFAULT_REVIEW_POLICY;
  return asReviewPolicy(deps.settings?.get(reviewPolicyKey(repo))) ?? DEFAULT_REVIEW_POLICY;
};

const AUTHOR_POLICY_PREFIX = "review_policy_author:";

/**
 * The policy a PR is on: its repository's, made stricter by its author's when
 * that author is configured. GitHub is only asked who wrote the PR when some
 * author policy exists, so the common case costs no extra `gh` call.
 */
const reviewPolicyOf = async (deps: CommandDeps, prUrl: string): Promise<ReviewPolicy> => {
  const repo = repoPolicyOf(deps, prUrl);
  if (repo === "approve-after") return repo;
  const anyAuthor = deps.settings?.list?.()?.some((e) => e.key.startsWith(AUTHOR_POLICY_PREFIX) && asReviewPolicy(e.value));
  if (!anyAuthor || !deps.github?.author) return repo;
  const login = authorRefOf((await deps.github.author(prUrl)) ?? "");
  if (!login) return repo;
  return stricterPolicy(repo, asReviewPolicy(deps.settings?.get(authorReviewPolicyKey(login))));
};

/** Every url's policy, looked up once and in parallel. */
const reviewPoliciesOf = async (deps: CommandDeps, urls: readonly string[]): Promise<Map<string, ReviewPolicy>> =>
  new Map(await Promise.all(urls.map(async (u) => [u, await reviewPolicyOf(deps, u)] as const)));

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

/**
 * A code with only a moment left is a code that fails while it is being typed,
 * so under this many seconds the next one is handed over instead.
 */
const MIN_CODE_SECONDS = 5;

/**
 * Ask for a 2FA setup key, with the button that opens the modal. Same shape as
 * the token ask and for the same reason: the key itself is never typed into a
 * channel, and the button carries only the label it will be filed under.
 *
 * Returns "" when the button was posted (the thread has it), or the text to show
 * when there is nowhere to put one - a slash invocation, or no Slack wired up.
 */
const askForSecret = async (ctx: Context, label: string): Promise<string> => {
  const { deps, channelId, threadTs, slash } = ctx;
  const ask = `🔐 paste the setup key for \`${label}\` - the \`otpauth://\` link the QR code encodes, or the base32 key printed beside it`;
  if (ctx.reply && deps.slack?.postInteractive) {
    const posted = await deps.slack
      .postInteractive(
        channelId,
        ask,
        [
          {
            actionId: TOTP_ACTION,
            label: "Paste the setup key",
            value: encodeTotpRequest({ channelId, threadTs, label }),
            style: "primary",
          },
        ],
        threadTs,
      )
      .catch(() => undefined);
    if (posted) return "";
  }
  return `${ask}\n\nrun \`${slash} 2fa add ${label}\` in a channel I am in and a box will open for it`;
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

/**
 * Lowest role that may run `read`. Defaults to admin: it borrows the host
 * human's Slack and Notion access, so this is a trust decision, not a detail.
 */
const readFloorOf = (deps: CommandDeps): UserRole =>
  roleOf(deps.settings?.get(SETTING_KEYS.readMinRole)?.trim().toLowerCase()) ?? "admin";

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
    // The brain runs this for ITSELF - it is told never to read its own source
    // to find out what it can do, so `help` is the answer. Nobody else wants
    // the whole command list dropped into their thread when it does. Quiet
    // sends the list back to the brain; a person typing it still gets the menu,
    // because `respond` wires a reply for a message command.
    quiet: true,
    // `menu` because that is the word people reach for once it IS one.
    aliases: ["commands", "menu", "?"],
    minRole: "pal",
    usage: "",
    summary: "list the commands you can run",
    run: async ({ deps, actor, channelId, threadTs, prefix, slash, reply }) => {
      // A menu where there is a Slack to put one in, the plain list everywhere
      // else - the dashboard, a test, a transport with no interactivity. The
      // list is still the fallback rather than an error, because help that
      // fails is worse than help that is merely old-fashioned.
      const menu = buildCommandMenu(listCommandInfo(), actor.role);
      const listed = renderHelp(actor.role, prefix, slash);
      // Only a person gets a menu. Without a reply wired this is the brain
      // asking itself what it can run, and a picker posted into the thread
      // would be the noise this command is quiet to avoid.
      if (reply && deps.slack && channelId && menu.groups.length > 0) {
        const posted = await deps.slack
          .postMenu(
            channelId,
            `${listed}\n\n${menuPrompt(menu)}`,
            {
              select: {
                actionId: MENU_SELECT_ACTION,
                placeholder: "Pick a command",
                groups: menu.groups,
              },
              actions: menu.quick.map((c) => ({
                actionId: menuRunActionId(c.name),
                label: c.name,
                value: c.name,
              })),
            },
            threadTs,
          )
          .catch(() => undefined);
        if (posted) return "";
      }
      return listed;
    },
  },
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
        bill: { actor: actor.slackId, kind: "ask", channel: channelId },
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
        bill: { actor: actor.slackId, kind: "btw", channel: channelId },
      });
      // Nothing is appended to `messages` on the way out, so the thread's next
      // real turn never sees this exchange in its unseen turns.
      return reply.trim() || "Nothing useful to add on that one.";
    },
  },
  {
    name: "forget",
    minRole: "pal",
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
      if (deps.users.get(who)) return `<@${who}> is already on the list - \`${prefix} kick\` is what you want.`;
      if (current.includes(who)) return "they are already snubbed.";
      deps.settings.set(SETTING_KEYS.snubbed, formatSnubbed([...current, who]));
      return `<@${who}> will be turned away without troubling anyone 😏`;
    },
  },
  {
    name: "follow",
    aliases: ["autoreply"],
    // It makes the bot speak in a room without being spoken to, which is a
    // standing decision about a shared space rather than a one-off reply.
    minRole: "admin",
    usage: "[<thread link>] | off [<thread link>] | list",
    summary: "keep up with a thread without being tagged in every message",
    run: ({ deps, actor, args, rest, prefix, threadTs, channelId }) => {
      if (!deps.follows) return "I cannot keep track of followed threads right now.";
      const sub = (args[0] ?? "").toLowerCase();

      if (sub === "list") {
        const all = deps.follows.list(30);
        if (all.length === 0) return "I am not following any thread I did not start.";
        return all
          .map((f) => `- <#${f.channelId}> \`${f.threadTs}\` - added by <@${f.addedBy}>`)
          .join("\n");
      }

      const off = sub === "off" || sub === "stop" || sub === "no";
      const linkArg = off ? (args[1] ?? "") : (args[0] ?? "");
      const ref = linkArg ? parseMessageLink(linkArg.replace(/^<|>$/g, "")) : undefined;
      if (linkArg && !ref) return `That is not a Slack thread link. \`${prefix} follow <thread link>\``;
      // A link wins; otherwise it is the thread this was typed in.
      const target = ref ?? (threadTs ? { channel: channelId, ts: threadTs } : undefined);
      if (!target) {
        return `Which thread? Run it in the thread, or \`${prefix} follow <thread link>\``;
      }

      if (off) {
        return deps.follows.remove(target.channel, target.ts)
          ? "stopped following that one - I will only answer there when tagged now 🫧"
          : "I was not following that thread.";
      }
      deps.follows.add(target.channel, target.ts, actor.slackId, deps.clock());
      void rest;
      return `following that thread now - I will read every message in it and answer when I actually have something, without being tagged. Most of the time that means staying quiet. \`${prefix} follow off\` to stop 👀`;
    },
  },
  {
    name: "watch",
    aliases: ["waitfor"],
    // The predicate is a shell command that runs as the bot, on a timer,
    // outside any turn. That is the same authority a full-access turn has, so
    // it takes the same trust - and it is the gate that stops a sandboxed
    // session from scheduling itself a shell.
    minRole: "admin",
    // The confirmation is for the brain, not the thread: it already says what
    // it is waiting for in its own words, and a second notice is just noise.
    quiet: true,
    usage: "pr|checks|reply|url <target> <what to do> | <what to do> -- <shell check> | list | cancel",
    summary: "wait for a PR, CI, a reply or a url, then carry on in this thread by itself",
    run: async ({ deps, actor, args, rest, prefix, threadTs, channelId }) => {
      if (!deps.watches) return "I have nowhere to keep a watch right now.";
      const sub = (args[0] ?? "").toLowerCase();

      if (sub === "list") {
        const waiting = deps.watches.waiting(20);
        if (waiting.length === 0) return "I am not waiting for anything.";
        const now = deps.clock();
        return waiting
          .map(
            (w) =>
              `- #${w.id} <#${w.channelId}> ${w.check ? `\`${w.check.slice(0, 60)}\`` : "timer"} - every ${humanDuration(w.everyMs)}, ${humanDuration(Math.max(0, w.deadlineAt - now))} left, ${w.attempts} checks`,
          )
          .join("\n");
      }

      if (sub === "cancel" || sub === "stop") {
        if (!threadTs) return "Cancel which thread's watch? Run it in the thread.";
        const n = deps.watches.cancelThread(channelId, threadTs, deps.clock());
        return n > 0 ? `stopped ${n} watch${n === 1 ? "" : "es"} here` : "nothing was being watched here.";
      }

      if (!threadTs) {
        return "A watch belongs to a thread - run it in the one that should carry on.";
      }
      const parsed = parseWatchArgs(rest);
      if (!parsed.ok) {
        return `${parsed.error}. \`${prefix} watch pr <url> <what to do>\`, or \`${prefix} watch <what to do> -- <shell check>\``;
      }
      const now = deps.clock();
      // A named wait builds its own predicate. The raw `-- <shell>` form still
      // wins if both were given: somebody who wrote a command meant it.
      let check = parsed.check;
      if (!check && parsed.kind) {
        const ref = parsed.kind === "reply" ? parseMessageLink(parsed.target ?? "") : undefined;
        const built = builtinCheck(parsed.kind, parsed.target ?? "", {
          slackWaitScript: deps.slackWaitScript,
          channel: ref?.channel,
          threadTs: ref?.ts,
          // Only what is said from NOW counts; the thread's existing replies
          // are not an answer to a question asked after them.
          afterTs: (now / 1000).toFixed(6),
          from: parsed.from,
        });
        if ("error" in built) return built.error;
        check = built.check;
      }
      if (!check && !parsed.kind) {
        // A plain timer, which is allowed - but say so, because "watch" with
        // no check reads like it is watching something.
      }
      const w = deps.watches.add(
        {
          channelId,
          threadTs,
          slackUserId: actor.slackId,
          note: parsed.note,
          check,
          everyMs: parsed.everyMs,
          deadlineAt: now + parsed.deadlineMs,
          createdAt: now,
        },
        now,
      );
      const what =
        parsed.kind === "pr"
          ? `${parsed.target} to be merged`
          : parsed.kind === "checks"
            ? `CI on ${parsed.target}`
            : parsed.kind === "reply"
              ? `a reply in that thread${parsed.from ? ` from <@${parsed.from}>` : ""}`
              : parsed.kind === "url"
                ? parsed.target
                : "";
      if (what) {
        return `⏳ waiting for ${what}, checking every ${humanDuration(parsed.everyMs)} and giving up after ${humanDuration(parsed.deadlineMs)}. I will carry on here by myself - you can still talk to me meanwhile. (\`${prefix} watch cancel\`, #${w.id})`;
      }
      return check
        ? `⏳ watching: \`${check.slice(0, 80)}\`\nevery ${humanDuration(parsed.everyMs)}, giving up after ${humanDuration(parsed.deadlineMs)}. I will carry on here by myself when it passes. (\`${prefix} watch cancel\`, #${w.id})`
        : `⏳ I will pick this up again in ${humanDuration(parsed.deadlineMs)}. (\`${prefix} watch cancel\`, #${w.id})`;
    },
  },
  {
    name: "mindful",
    aliases: ["mind", "whatsup"],
    // It names people, quotes what they asked, and spans every conversation
    // the bot can see - DMs and private channels the reader may not be in.
    minRole: "admin",
    usage: "[hours] | continue <thread link> | reply <thread link> [what to say]",
    summary: "everything I am doing: what is stuck, what is running, what it cost",
    run: async (ctx) => {
      const { deps, actor, args, prefix, channelId } = ctx;
      const sub = (args[0] ?? "").toLowerCase();
      const team = deps.slackTeam?.();

      if (sub === "continue" || sub === "retry" || sub === "reply") {
        if (!deps.runTurn) return "I cannot start a turn from here right now.";
        const ref = parseMessageLink((args[1] ?? "").replace(/^<|>$/g, ""));
        if (!ref) return `Which thread? \`${prefix} mindful ${sub} <thread link>\``;
        const said = args.slice(2).join(" ").trim();

        if (sub === "reply") {
          // Nudging a thread it has gone quiet in. With nothing said, it is
          // told to catch up and answer only if it has something - the same
          // judgement it uses when following its own threads.
          const text =
            said ||
            "Read this thread from the start, then reply only if you have something it needs. If you do not, say nothing.";
          await deps.runTurn({ channelId: ref.channel, threadTs: ref.ts, slackUserId: actor.slackId, text });
          return `nudged that thread${said ? "" : " - it will answer only if it has something"} 🫧`;
        }

        // Continue: run the dead turn again, as the person who asked for it
        // the first time. Their request is in the turn log precisely so this
        // does not depend on a `messages` table a `forget` can empty.
        const last = deps.turns?.latestInThread(ref.channel, ref.ts);
        if (!last) return "I have no record of a turn in that thread.";
        if (last.outcome === "ok" && !said) {
          return `The last turn there finished fine. \`${prefix} mindful reply <link> <what to ask>\` if you want something new.`;
        }
        const text = said || last.request;
        if (!text.trim()) return "That turn left nothing to run again.";
        await deps.runTurn({
          channelId: ref.channel,
          threadTs: ref.ts,
          slackUserId: last.slackUserId || actor.slackId,
          text,
        });
        return `running that one again for <@${last.slackUserId || actor.slackId}> 🔁`;
      }

      const windowMs = parseWindow(args[0]) ?? 4 * 60 * 60_000;
      const since = deps.clock() - windowMs;

      const live: LiveRun[] = (deps.runs?.all() ?? []).map((r) => ({
        id: r.id,
        channelId: r.channelId,
        threadTs: r.threadTs,
        actor: r.actor,
        what: r.what,
        startedAt: r.startedAt,
        state: r.state,
      }));

      const recent = deps.turns?.since(since, 500) ?? [];
      const done = {
        ok: recent.filter((t) => t.outcome === "ok").length,
        failed: recent.filter((t) => t.outcome === "failed").length,
        stopped: recent.filter((t) => t.outcome === "stopped").length,
      };

      const view: MindfulView = {
        now: deps.clock(),
        live,
        stuck: (deps.turns?.stuckThreads(since, 12) ?? []).map((t) => ({
          channelId: t.channelId,
          threadTs: t.threadTs,
          slackUserId: t.slackUserId,
          request: t.request,
          error: t.error,
          outcome: t.outcome,
          endedAt: t.endedAt,
        })),
        watching: (deps.watches?.waiting(15) ?? []).map((w) => ({
          id: w.id,
          channelId: w.channelId,
          threadTs: w.threadTs,
          check: w.check,
          note: w.note,
          deadlineAt: w.deadlineAt,
          attempts: w.attempts,
        })),
        workflows: (deps.workflows?.listActive() ?? []).map((w) => ({
          channelId: w.channelId,
          threadTs: w.threadTs,
          task: w.task,
          lastTurnAt: w.updatedAt,
        })),
        done,
        spend: deps.usage?.totals(since) ?? {
          runs: 0,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
          durationMs: 0,
        },
        windowMs,
      };

      // One permalink resolves the workspace domain; every other link is then
      // built from ids rather than costing an API call of its own.
      const anchor = view.stuck[0] ?? view.workflows[0];
      const resolved =
        team ??
        (anchor && deps.slack?.permalink
          ? teamFromPermalink(await deps.slack.permalink(anchor.channelId, anchor.threadTs))
          : undefined);
      const report = mindfulReport(view, resolved);
      const hint = view.stuck.length > 0 ? `\n\n_\`${prefix} mindful continue <thread link>\` runs a stuck one again_` : "";
      void channelId;
      return `${report}${hint}`;
    },
  },
  {
    name: "spend",
    aliases: ["cost", "tokens"],
    // It names people and what they cost, which is nobody's business at pal
    // level, and it describes the bill for somebody's own account.
    minRole: "admin",
    usage: "[hours|7d]",
    summary: "what the model has cost, by person and by command",
    run: ({ deps, args }) => {
      if (!deps.usage) return "I am not recording what runs cost right now.";
      const windowMs = parseWindow(args[0]) ?? 24 * 60 * 60_000;
      const since = deps.clock() - windowMs;
      const names = new Map(
        deps.users.list().map((u) => [u.slackId, u.displayName || `<@${u.slackId}>`] as const),
      );
      return spendReport(
        deps.usage.totals(since),
        deps.usage.byUser(since, 15),
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
    name: "adapter",
    aliases: ["memory"],
    minRole: "admin",
    usage: "[status|check|history|refine [note]|revert <id>|migrate]",
    summary: "inspect and curate what I remember",
    run: async (ctx) => {
      const { deps, actor, args, rest, prefix, reply, channelId } = ctx;
      const a = adapterDepsOf(deps);
      if (!a) return "No memory adapter is configured, so I am still on the flat learnings list.";
      const sub = (args[0] ?? "status").toLowerCase();

      if (sub === "status") return adapterStatus(a);

      if (sub === "check") {
        const files = a.store.files();
        const result = commitAdapter(a, files, { reason: "check", actor: actor.slackId });
        // A check is a dry run: committing the files it already has changes
        // nothing on disk, and the gate is the only thing being asked.
        return result.ok
          ? `${describeCheck({ ok: true, violations: [] })}\n\n${adapterStatus(a)}`
          : `The adapter does NOT pass:\n${result.violations.map((v) => `- ${v}`).join("\n")}`;
      }

      if (sub === "history") {
        const list = a.revisions?.list(15) ?? [];
        if (list.length === 0) return "No revisions yet.";
        return list
          .map((r) => `- #${r.id} ${new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ")} ${r.reason}`)
          .join("\n");
      }

      if (sub === "revert") {
        const id = Number(args[1]);
        if (!Number.isInteger(id)) return `Which one? \`${prefix} adapter revert <id>\` (see \`${prefix} adapter history\`)`;
        const result = revertAdapter(a, id, actor.slackId);
        return result.ok
          ? `Reverted to #${id}${result.revision ? ` (now #${result.revision})` : ""}.\n\n${adapterStatus(a)}`
          : `Could not revert:\n${result.violations.map((v) => `- ${v}`).join("\n")}`;
      }

      if (sub === "migrate") {
        const list = deps.learnings?.list() ?? [];
        if (list.length === 0) return "The learnings list is empty - nothing to migrate.";
        const result = migrateLearnings(a, list.map((l) => l.content), actor.slackId, () => {
          // One store of memory, not two. The old rows are in the revision
          // this just wrote, and in git.
          for (const l of list) deps.learnings?.remove(l.id);
        });
        if (!result.ok) return `Could not migrate:\n${result.violations.map((v) => `- ${v}`).join("\n")}`;
        return [
          `Moved ${list.length} learnings into the adapter${result.revision ? ` (#${result.revision})` : ""} and emptied the old list.`,
          `They went in unsorted and unmerged, exactly as they were - revision #${result.revision ?? "?"} is the record.`,
          `Run \`${prefix} adapter refine\` to actually curate them.`,
          ...(result.warnings.length > 0 ? ["", ...result.warnings.map((w) => `:warning: ${w}`)] : []),
        ].join("\n");
      }

      if (sub !== "refine") return `Which one? \`${prefix} adapter [status|check|history|refine|revert <id>|migrate]\``;

      if (!deps.llm) return "My brain is not wired up right now.";
      const note = rest.slice(rest.toLowerCase().indexOf("refine") + "refine".length).trim();
      const adapter = a.store.load();
      const currentBytes = new TextEncoder().encode(
        [adapterRules(adapter), isBlank(adapter.notes) ? "" : adapter.notes].filter(Boolean).join("\n\n"),
      ).length;
      const budget = a.budget ?? ALWAYS_ON_BUDGET;

      // The pass edits a throwaway copy; what comes back is gated and
      // committed here. The model never writes the live adapter.
      const staging = a.store.stage();
      const name = botNameOf(deps);
      const full = deps.toolPolicy?.("owner") ?? { skipPermissions: true };
      const params = {
        system: refinePrompt({ currentBytes, budget, note: note || undefined }, name),
        messages: [{ role: "user" as const, content: note || "Curate my memory." }],
        assistantName: name,
        policy: { ...full, cwd: staging, timeoutMs: REFINE_TIMEOUT_MS },
        bill: { actor: actor.slackId, kind: "adapter", channel: channelId },
      };

      if (reply) await reply("🧹 going through what I remember");
      let out = "";
      try {
        out = deps.llm.stream && reply ? await deps.llm.stream(params, () => {}) : await deps.llm.complete(params);
        const next = a.store.collect(staging);
        if (next.size === 0) return "The pass came back with nothing, so I left my memory alone.";
        const result = commitAdapter(a, next, {
          reason: note ? `refine: ${note.slice(0, 100)}` : "refine",
          actor: actor.slackId,
          enforceBudget: true,
          enforceFixed: true,
        });
        if (!result.ok) {
          return [
            "That pass did not pass its own checks, so I kept what I had:",
            ...result.violations.map((v) => `- ${v}`),
          ].join("\n");
        }
        const summary = out.trim() || "Done.";
        const tail = `\n\n${adapterStatus(a)}\n_revision #${result.revision ?? "?"} - \`${prefix} adapter revert ${result.revision ?? ""}\` puts it back_`;
        if (reply) {
          await reply(summary + tail);
          return "";
        }
        return summary + tail;
      } finally {
        a.store.discard(staging);
      }
    },
  },
  {
    name: "learn",
    minRole: "admin",
    usage: "<fact>",
    summary: "teach me a durable fact",
    run: ({ deps, actor, rest, prefix }) => {
      const fact = rest.trim();
      if (!fact) return `Teach me something: \`${prefix} learn <fact>\``;

      // With an adapter, the fact lands in the inbox heading and a refine pass
      // files it. Teaching stays instant and is never refused - the moment
      // "remember this" can fail, people stop telling me things - so the
      // budget is reported here rather than enforced.
      const a = adapterDepsOf(deps);
      if (a) {
        const result = rememberFact(a, fact, { kind: "global" }, actor.slackId);
        if (!result.ok) return `I could not keep that:\n${result.violations.map((v) => `- ${v}`).join("\n")}`;
        const nag =
          result.warnings.length > 0
            ? `\n:warning: my always-on memory is over budget - \`${prefix} adapter refine\` will tidy it.`
            : "";
        return `Learned it. I will keep that in mind.${nag}`;
      }

      if (!deps.learnings) return "Learnings are not available.";
      const l = deps.learnings.add(fact, actor.slackId, deps.clock());
      return `Learned it (#${l.id}). I will keep that in mind.`;
    },
  },
  {
    name: "learnings",
    minRole: "admin",
    usage: "",
    summary: "list what I have learned",
    run: ({ deps, prefix }) => {
      const a = adapterDepsOf(deps);
      if (a) {
        const adapter = a.store.load();
        const blocks = [
          isBlank(adapter.policy) ? "" : `*Policy*\n${adapter.policy}`,
          isBlank(adapter.notes) ? "" : `*Notes*\n${adapter.notes}`,
          adapter.skills.length === 0
            ? ""
            : `*In depth*\n${adapter.skills.map((sk) => `- ${sk.name}: ${sk.description}`).join("\n")}`,
          adapter.people.size + adapter.channels.size === 0
            ? ""
            : `_plus ${adapter.people.size} people and ${adapter.channels.size} channels I keep separate notes on_`,
        ].filter(Boolean);
        return blocks.length === 0
          ? "I have not learned anything yet."
          : `${blocks.join("\n\n")}\n\n_\`${prefix} adapter\` for the numbers_`;
      }
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
      if (adapterDepsOf(deps)) {
        return `My memory is an adapter now, so there are no numbered learnings to edit. Use \`${prefix} adapter refine\` to curate it, or \`${prefix} adapter revert <id>\` to undo a pass.`;
      }
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
      if (adapterDepsOf(deps)) {
        return `My memory is an adapter now, so there are no numbered learnings to edit. Use \`${prefix} adapter refine\` to curate it, or \`${prefix} adapter revert <id>\` to undo a pass.`;
      }
      if (!deps.learnings) return "Learnings are not available.";
      const id = Number(args[0]);
      if (!Number.isInteger(id)) return `Which one? \`${prefix} unlearn <id>\` (see \`${prefix} learnings\`)`;
      deps.learnings.remove(id);
      return `Forgotten learning #${id}.`;
    },
  },
  {
    name: "close",
    aliases: ["resolve"],
    // A tool, like `note`: the brain closes a ticket mid-job and carries on.
    quiet: true,
    // Closing someone's ticket in the team tracker is an admin act. It is one
    // reversible property, which is why it is not owner-only.
    minRole: "admin",
    usage: "<ticket url or id> <why>",
    summary: "close a ticket in the tracker, recording who decided and why",
    run: async (ctx) => {
      const { deps, actor, args, rest, prefix, reply, channelId } = ctx;
      const ref = (args[0] ?? "").trim();
      const tracker = deps.settings?.get(SETTING_KEYS.ticketTracker)?.trim() || "";
      if (!ref) return `Close what? \`${prefix} close <ticket url or id> <why>\``;
      if (!tracker) return `No ticket tracker is configured, so I do not know which pages are ours to close.`;
      const why = rest.slice(rest.indexOf(ref) + ref.length).trim();
      if (!why) return `Why is it being closed? \`${prefix} close ${ref} <why>\` - a close with no reason is the same as one by accident.`;
      if (!deps.llm) return "My brain is not wired up right now.";

      const full = deps.toolPolicy?.("owner") ?? { skipPermissions: true };
      const name = botNameOf(deps);
      const params = {
        system: closePrompt({ ref, why, tracker, askedBy: actor.slackId }, name),
        messages: [{ role: "user" as const, content: `close ${ref}: ${why}` }],
        assistantName: name,
        policy: { ...full, timeoutMs: CLOSE_TIMEOUT_MS },
        // The tracker lives behind the account's Notion connector, which a
        // setup token does not carry.
        useHostLogin: true,
        bill: { actor: actor.slackId, kind: "close", channel: channelId },
      };

      if (!reply) {
        const out = await deps.llm.complete(params);
        return out.trim() || "I could not close that one.";
      }
      await reply(`🗂️ closing ${ref} for <@${actor.slackId}>`);
      let out = "";
      try {
        out = deps.llm.stream ? await deps.llm.stream(params, () => {}) : await deps.llm.complete(params);
      } catch (err) {
        if (!isAuthFailure(err)) throw err;
        await reply(
          "🔑 I could not close it - the login on my host has lapsed, and the tracker comes with it. Someone with access to the machine needs to run `claude` there and sign in again.",
        );
        return "";
      }
      await reply(out.trim() || "I could not close that one.");
      return "";
    },
  },
  {
    name: "note",
    aliases: ["publish"],
    // A tool, like `read`: the brain publishes mid-task and carries on with the
    // url. The counterpart to reading, and the reason this exists at all - the
    // bot used to finish a twenty minute job and tell someone to paste it in.
    quiet: true,
    minRole: "pal",
    usage: "<file> [title | <notion url> | --append <notion url>] | parent <notion url> | access <role>",
    summary: "publish a document into Notion, or update a page that is already there",
    run: async (ctx) => {
      const { deps, actor, args, prefix, reply, channelId } = ctx;
      const first = (args[0] ?? "").trim();
      const parent = deps.settings?.get(SETTING_KEYS.notionParent)?.trim() || "";
      const floor = roleOf(deps.settings?.get(SETTING_KEYS.noteMinRole)?.trim().toLowerCase() ?? "") ?? "admin";

      if (first.toLowerCase() === "parent") {
        const url = (args[1] ?? "").trim();
        if (!url) return `Where should pages go? \`${prefix} note parent <notion url>\` (now: ${parent || "*not set*"})`;
        if (RANK[actor.role] < RANK.admin) return "Only admins can set where my pages go.";
        deps.settings?.set(SETTING_KEYS.notionParent, url);
        return `New pages will go under ${url}.`;
      }

      if (first.toLowerCase() === "access") {
        const want = roleOf((args[1] ?? "").toLowerCase());
        if (!want) return `Which role? \`${prefix} note access <pal|executer|admin|owner>\` (now: *${floor}*)`;
        if (RANK[actor.role] < RANK.admin) return "Only admins can change who may publish.";
        deps.settings?.set(SETTING_KEYS.noteMinRole, want);
        return `\`note\` is now open to *${want}* and above. It writes under my host's Notion identity, so anyone at that level publishes as them.`;
      }

      if (RANK[actor.role] < RANK[floor]) {
        return `I cannot publish that myself - \`note\` writes with my host's Notion identity and is limited to *${floor}* and above. Ask someone at that level to run \`${prefix} note <file>\`.`;
      }
      if (!first) return `Publish what? \`${prefix} note <file> [title]\``;
      // Creating needs somewhere to put it; updating already knows where it is
      // going, so a missing parent must not stand in the way of an edit.
      const aim = parseNoteArgs(args);
      if (!aim.ok) return `${aim.error}. \`${prefix} note <file> [title]\`, or \`${prefix} note <file> <notion url>\` to update that page.`;
      if (aim.mode === "create" && !parent) {
        return `I have nowhere to put it - no Notion parent is configured. An admin can set one: \`${prefix} note parent <notion url>\``;
      }
      if (!deps.llm) return "My brain is not wired up right now.";

      const title = aim.title;
      const full = deps.toolPolicy?.("owner") ?? { skipPermissions: true };
      const name = botNameOf(deps);
      const params = {
        system: notePrompt(
          { path: aim.path, title, parent, askedBy: actor.slackId, mode: aim.mode, target: aim.target },
          name,
        ),
        messages: [
          {
            role: "user" as const,
            content:
              aim.mode === "create"
                ? `publish ${aim.path}${title ? ` as "${title}"` : ""}`
                : `${aim.mode === "append" ? "append" : "update"} ${aim.target} from ${aim.path}`,
          },
        ],
        assistantName: name,
        policy: { ...full, timeoutMs: NOTE_TIMEOUT_MS },
        // Notion lives with the host's interactive login; a setup token carries
        // no connectors at all, so this is the only credential that can write.
        useHostLogin: true,
        bill: { actor: actor.slackId, kind: "note", channel: channelId },
      };

      if (!reply) {
        const out = await deps.llm.complete(params);
        return out.trim() || "I could not publish that one.";
      }
      await reply(
        aim.mode === "create"
          ? `📝 publishing that to Notion for <@${actor.slackId}>`
          : `📝 ${aim.mode === "append" ? "adding that to" : "updating"} ${aim.target} for <@${actor.slackId}>`,
      );
      let out = "";
      try {
        out = deps.llm.stream ? await deps.llm.stream(params, () => {}) : await deps.llm.complete(params);
      } catch (err) {
        if (!isAuthFailure(err)) throw err;
        await reply(
          "🔑 I could not publish it - the login on my host has lapsed, and Notion comes with it. Someone with access to the machine needs to run `claude` there and sign in again.",
        );
        return "";
      }
      await reply(out.trim() || "I could not publish that one.");
      return "";
    },
  },
  {
    name: "read",
    aliases: ["summarise", "summarize", "catchup"],
    // A step inside a larger job, not an announcement. When the brain reaches
    // for it mid-task the content comes back to it; posting the document into
    // the thread as well is the noise that made this feel like a dump.
    quiet: true,
    // The entry gate is `pal` so the command is reachable; the real threshold is
    // configurable and checked below. It reads with the authorising human's
    // access, so whoever may run it can read anything that person can - which
    // is a decision for whoever owns this instance, not a constant.
    minRole: "pal",
    usage: "<link> [what you want from it] | access <role>",
    summary: "read something my own token cannot - a Notion page, a channel I am not in - through the account's connectors",
    run: async (ctx) => {
      const { deps, actor, channelId, threadTs, args, rest, prefix, reply } = ctx;
      const target = (args[0] ?? "").trim();

      // Who may borrow the host's access, as configuration rather than a
      // constant: owner-only made the command useless for the case it exists
      // for - a colleague asking it to follow a document the team shares.
      const floor = readFloorOf(deps);
      if (target.toLowerCase() === "access") {
        const want = roleOf((args[1] ?? "").toLowerCase());
        if (!want) return `Which role? \`${prefix} read access <pal|executer|admin|owner>\` (now: *${floor}*)`;
        if (RANK[actor.role] < RANK.admin) return "Only admins can change who may use `read`.";
        deps.settings?.set(SETTING_KEYS.readMinRole, want);
        return `\`read\` is now open to *${want}* and above. It borrows my host's Slack and Notion access, so anyone at that level can have me read anything that account can see.`;
      }

      if (RANK[actor.role] < RANK[floor]) {
        return `I cannot open that one myself - \`read\` borrows my host's access and is limited to *${floor}* and above. Ask someone at that level to run \`${prefix} read <link>\`, or paste the content here and I will work from that.`;
      }

      if (!target) return `Read what? \`${prefix} read <link>\``;
      if (!deps.llm) return "My brain is not wired up right now.";

      const note = rest.slice(rest.indexOf(target) + target.length).trim();
      const full = deps.toolPolicy?.("owner") ?? { skipPermissions: true };
      const name = botNameOf(deps);
      const params = {
        system: readPrompt({ target, note, channelId, threadTs, askedBy: actor.slackId, artifactScript: deps.artifactScript }, name),
        messages: [{ role: "user" as const, content: `read ${target}${note ? `\n\n${note}` : ""}` }],
        assistantName: name,
        policy: { ...full, timeoutMs: READ_TIMEOUT_MS },
        // The connector lives with the host's interactive login; a setup token
        // carries none, so this is the only credential that can see it.
        useHostLogin: true,
        bill: { actor: actor.slackId, kind: "read", channel: channelId },
      };

      if (!reply) {
        const out = await deps.llm.complete(params);
        return out.trim() || "I could not read that one.";
      }

      await reply(`👀 reading that for <@${actor.slackId}>`);
      let out = "";
      try {
        out = deps.llm.stream
          ? await deps.llm.stream(params, () => {})
          : await deps.llm.complete(params);
      } catch (err) {
        if (!isAuthFailure(err)) throw err;
        await reply(
          "🔑 I could not read it - the login on my host has lapsed, and the Slack connector comes with it. Someone with access to the machine needs to run `claude` there and sign in again.",
        );
        return "";
      }
      await reply(out.trim() || "I could not read that one.");
      return "";
    },
  },
  {
    name: "investigate",
    aliases: ["inv", "rca"],
    minRole: "pal",
    usage: "<what to look into>",
    summary: "dig through logs, RUM and traces for the cause - runs with the connectors loaded",
    run: async (ctx) => {
      const { deps, actor, channelId, threadTs, rest, prefix, reply } = ctx;
      const question = rest.trim();
      if (!question) return `What should I look into? \`${prefix} investigate <what happened>\``;
      if (!deps.llm) return "My brain is not wired up right now.";

      const order = logSourceOrder(deps.settings?.get(SETTING_KEYS.logSources));
      if (order.length === 0) {
        return `No log sources are configured, so there is nowhere for me to look. An admin can set them: \`${prefix} logsource grafana,datadog\``;
      }

      // A preset full-access task, and - like a ticket - one that runs on the
      // HOST login rather than any setup token. Datadog (and RUM in particular)
      // is reachable only through the account's connectors, which a setup token
      // carries none of; that credential split is the whole reason this is its
      // own command instead of something chat does inline.
      const full = deps.toolPolicy?.("owner") ?? { skipPermissions: true };
      const name = botNameOf(deps);
      const params = {
        system: investigatePrompt(question, name, order, deps.grafanaGetScript, {
          channelId,
          threadTs,
          askedBy: actor.slackId,
        }),
        messages: [{ role: "user" as const, content: question }],
        assistantName: name,
        policy: { ...full, timeoutMs: INVESTIGATE_TIMEOUT_MS },
        useHostLogin: true,
        bill: { actor: actor.slackId, kind: "investigate", channel: channelId },
      };

      if (!reply) {
        const out = await deps.llm.complete(params);
        return out.trim() || "I could not get to the bottom of that one.";
      }

      await reply(`🔎 investigating for <@${actor.slackId}>`);
      let out = "";
      try {
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
            // Which source actually answered is the thing people most want to
            // know mid-run, and the thing a report most often blurs.
            if (/mcp__.*datadog.*rum/.test(ran)) announce("📊 reading RUM in Datadog");
            else if (/mcp__.*datadog/.test(ran)) announce("🐶 querying Datadog");
            if (/gcx |grafana-get\.sh/.test(ran)) announce("📈 querying Grafana");
          });
        } else {
          out = await deps.llm.complete(params);
        }
      } catch (err) {
        if (!isAuthFailure(err)) throw err;
        await reply(
          "🔑 I could not investigate - the login on my host has lapsed, and the connectors come with it. Someone with access to the machine needs to run `claude` there and sign in again.",
        );
        return "";
      }
      await reply(out.trim() || "I could not get to the bottom of that one.");
      return "";
    },
  },
  {
    name: "fanout",
    aliases: ["orca"],
    // the workers are Claude Code sessions Orca starts on the host, billed to
    // whoever is signed in there, so this is not a pal-level button
    minRole: "admin",
    usage: "<job to split across agents>",
    summary: "split a coding job across parallel Claude Code agents in Orca, one worktree each",
    run: async (ctx) => {
      const { deps, actor, channelId, threadTs, rest, prefix, reply } = ctx;
      const task = rest.trim();
      if (!task) return `What should the agents work on? \`${prefix} fanout <job>\``;
      if (!deps.llm) return "My brain is not wired up right now.";

      const full = deps.toolPolicy?.("owner") ?? { skipPermissions: true };
      const name = botNameOf(deps);
      const params = {
        system: fanoutPrompt(task, name, { channelId, threadTs, askedBy: actor.slackId }),
        messages: [{ role: "user" as const, content: task }],
        assistantName: name,
        policy: { ...full, timeoutMs: FANOUT_TIMEOUT_MS },
        bill: { actor: actor.slackId, kind: "fanout", channel: channelId },
      };

      if (!reply) {
        const out = await deps.llm.complete(params);
        return out.trim() || "The agents came back with nothing to report.";
      }

      await reply(`🐋 splitting that across agents in Orca for <@${actor.slackId}>`);
      let out = "";
      if (deps.llm.stream) {
        const started = new Set<string>();
        out = await deps.llm.stream(params, (ev) => {
          if (ev.type !== "tool" || ev.status !== "complete") return;
          const ran = ev.command ?? ev.title;
          const slug = /orca worktree create\b.*?--name\s+['"]?([\w.-]+)/.exec(ran)?.[1];
          if (!slug || started.has(slug)) return;
          started.add(slug);
          void reply(`🤖 started worker \`${slug}\``);
        });
      } else {
        out = await deps.llm.complete(params);
      }
      await reply(out.trim() || "The agents came back with nothing to report.");
      return "";
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
        // Not the caller's token, and not the bot's: a ticket has to read Notion,
        // and a `claude setup-token` credential carries no claude.ai connector
        // authorisation at all (verified: zero mcp__ tools under one). Only the
        // host's interactive login has the connectors, so this one task uses it.
        useHostLogin: true,
        bill: { actor: actor.slackId, kind: "ticket", channel: channelId },
      };

      if (!reply) {
        const out = await deps.llm.complete(params);
        return out.trim() || "I could not raise that one.";
      }

      await reply(`🎫 raising a ticket for <@${actor.slackId}>`);
      let out = "";
      try {
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
      } catch (err) {
        // The known failure mode of running on the host session: it lapsed. Say
        // that, because nothing in the thread would otherwise suggest a login.
        if (!isAuthFailure(err)) throw err;
        await reply(
          "🔑 I could not raise that one - the login on my host has lapsed, and a ticket needs it for Notion. Someone with access to the machine needs to run `claude` there and sign in again.",
        );
        return "";
      }
      await reply(out.trim() || "I could not raise that one.");
      return "";
    },
  },
  {
    name: "approve",
    minRole: "pal",
    usage: "<pr-url> [pr-url...]",
    summary: "approve a PR without reviewing it",
    /**
     * The most-guessed command that did not exist. Five people-months of log
     * say `approve <pr-url>`, every time answered with "I do not recognise
     * `approve`", once typed as "approvel without review please".
     *
     * It is not a new power: `review` approves up front already, in code,
     * before the brain is spawned - this is that same step with the review
     * left off, and it refuses exactly where `review` refuses. A repository
     * set to approve only AFTER a clean review is an admin's decision about
     * that repository, so a bare approval there is not on offer at any role.
     *
     * No brain, so no Claude token and no cost. The pal allowance is what
     * bounds it, which is also what makes it auditable: every approval is a
     * row in the command log against the person who asked for it.
     */
    run: async ({ deps, args, prefix }) => {
      if (!deps.github) return "I have no GitHub access wired up right now.";
      const urls = [...new Set(args.flatMap((a) => a.match(PR_URL) ?? []))];
      if (urls.length === 0) return `Which PR? \`${prefix} approve <pr-url>\``;
      const policies = await reviewPoliciesOf(deps, urls);
      const held = urls.filter((u) => policies.get(u) === "approve-after");
      const lines: string[] = [];
      for (const url of urls) {
        if (held.includes(url)) {
          lines.push(`⚠️ ${url} - that repo or author approves only after a clean review. \`${prefix} review ${url}\``);
          continue;
        }
        const res = await deps.github.approve(url);
        lines.push(res.ok ? `✅ approved ${url}` : `⚠️ could not approve ${url} - ${res.error}`);
      }
      // Say what it did NOT do. An approval with no review behind it is worth
      // one line of honesty, not a silent green tick.
      if (lines.some((l) => l.startsWith("✅"))) {
        lines.push(`_approved as asked, nobody read it - \`${prefix} review <pr-url>\` if you want that too_`);
      }
      return lines.join("\n");
    },
  },
  {
    name: "review",
    aliases: ["rv"],
    ownHelp: true,
    minRole: "pal",
    usage: "<pr-url> [pr-url...] [--policy first|after] [what to look at]",
    summary: "review a PR: approve it, then post the review to GitHub and here",
    run: async (ctx) => {
      const { deps, actor, args, prefix, reply, channelId } = ctx;
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
      // A policy asked for on the line itself, for this run only. Pulled out
      // first so it reaches neither the url parser nor the free-text note.
      const { asked, rest, bad } = parsePolicyArg(args);
      if (bad !== undefined) {
        return `\`${bad}\` is not a policy. \`--policy first\`, \`--policy after\`, or \`--policy default\`.`;
      }
      // What the review is actually about, before anything expensive happens.
      if (rest.length === 1 && /^(help|\?|--help|prompt|how)$/i.test(rest[0] ?? "")) {
        const wantPrompt = /^prompt$/i.test(rest[0] ?? "");
        const text = reviewHelp(prefix, wantPrompt, reviewAgentsOf(deps), botNameOf(deps));
        // The real prompt is longer than one Slack message, and a post that is
        // too long simply fails to land - which looks like being ignored.
        return wantPrompt ? clip(text) : text;
      }
      // Slack wraps links as <url|label>; hand the brain the bare urls.
      const urls = [...new Set(rest.flatMap((a) => a.match(PR_URL) ?? []))];
      // A shorthand the brain can resolve is fine; a stray word is not. Without
      // this, `review help` spawned a full review of a PR named "help" - minutes
      // of work on the asker's own credential, to answer a question.
      const shorthand = urls.length === 0 ? rest.filter(looksLikePrRef) : [];
      const targets = urls.length > 0 ? urls : shorthand;
      if (targets.length === 0) {
        return `Which PR? \`${prefix} review <pr-url>\` - or \`${prefix} review help\` for how I do it.`;
      }
      // Anything typed alongside the urls is guidance: "the migration is the
      // risky bit", "hotfix, correctness only". It aims the review; the prompt
      // is what keeps it from doing anything more than that.
      const note = urls.length > 0 ? rest.filter((a) => !PR_URL.test(a)).join(" ").trim() : "";
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
      // What each PR is on for this run: the flag if one was given, otherwise
      // whatever the repository is configured for.
      const override: ReviewPolicy | undefined =
        asked === "default" ? DEFAULT_REVIEW_POLICY : asked;
      // Asking for a stricter run is anyone's call. Asking for a looser one -
      // approving up front on a repository that deliberately waits for a clean
      // review - is overruling an admin's decision, so it takes one.
      const configured = await reviewPoliciesOf(deps, urls);
      const loosened = override === "approve-first" && urls.some((u) => configured.get(u) === "approve-after");
      if (loosened && RANK[actor.role] < RANK.admin) {
        return "That repo or author is set to approve only after a clean review, and only an admin can override that for a run.";
      }
      const policyFor = (url: string): ReviewPolicy => override ?? configured.get(url) ?? DEFAULT_REVIEW_POLICY;
      // Repositories on `approve-after` are left alone until the review is in.
      const afterReview = urls.filter((u) => policyFor(u) === "approve-after");
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
        bill: { actor: actor.slackId, kind: "review", channel: channelId },
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
      await reply(
        `🔍 reviewing ${targets.join(" ")}` +
          (override ? `\n_${override}, for this run only_` : "") +
          (note ? `\n_looking at: ${note}_` : ""),
      );

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
    usage: "[owner/repo | author:<login>] [first|after|default]",
    summary: "how a repo or PR author gets approved: up front, or only after a clean review",
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
              ?.filter(
                (e) =>
                  (e.key.startsWith("review_policy:") || e.key.startsWith(AUTHOR_POLICY_PREFIX)) &&
                  asReviewPolicy(e.value),
              )
              .map((e) =>
                e.key.startsWith(AUTHOR_POLICY_PREFIX)
                  ? `- author \`${e.key.slice(AUTHOR_POLICY_PREFIX.length)}\`: ${asReviewPolicy(e.value)}`
                  : `- \`${e.key.slice("review_policy:".length)}\`: ${asReviewPolicy(e.value)}`,
              )
          : undefined;
        const list = configured && configured.length > 0 ? `\n${configured.join("\n")}` : "\nNothing configured - every repo is on the default.";
        return `Default: *${DEFAULT_REVIEW_POLICY}* - ${describe(DEFAULT_REVIEW_POLICY)}.${list}`;
      }

      // A PR author is named `author:<login>` (or `@login`); anything else is a repo.
      const first = args[0] ?? "";
      const authorArg = /^author:(.+)$/i.exec(first)?.[1] ?? (first.startsWith("@") ? first : undefined);
      const login = authorArg !== undefined ? authorRefOf(authorArg) : undefined;
      if (authorArg !== undefined && !login) {
        return `Which author? \`${prefix} review-policy author:<github-login> [first|after|default]\``;
      }
      const repo = login ? `author ${login}` : repoRefOf(first);
      if (!repo) return `Which repo? \`${prefix} review-policy owner/repo [first|after|default]\``;
      const key = login ? authorReviewPolicyKey(login) : reviewPolicyKey(repo);
      if (args.length === 1) {
        const own = asReviewPolicy(deps.settings?.get(key));
        return own
          ? `\`${repo}\` is on *${own}* - ${describe(own)}.`
          : `\`${repo}\` uses the default, *${DEFAULT_REVIEW_POLICY}* - ${describe(DEFAULT_REVIEW_POLICY)}.`;
      }

      if (RANK[actor.role] < RANK.admin) return "Only admins can change a review policy.";
      const want = (args[1] ?? "").toLowerCase();
      if (want === "default" || want === "reset") {
        deps.settings?.set(key, "");
        return `\`${repo}\` is back on the default, *${DEFAULT_REVIEW_POLICY}*.`;
      }
      const policy: ReviewPolicy | undefined =
        want === "after" || want === "approve-after"
          ? "approve-after"
          : want === "first" || want === "approve-first"
            ? "approve-first"
            : undefined;
      if (!policy || args.length > 2) {
        return `First or after? \`${prefix} review-policy ${first} <first|after|default>\``;
      }
      deps.settings?.set(key, policy);
      return `\`${repo}\` is now *${policy}* - ${describe(policy)}.`;
    },
  },
  {
    name: "stop",
    aliases: ["cancel", "abort"],
    minRole: "pal",
    usage: "",
    summary: "stop the turn running in this thread",
    run: ({ deps, actor, channelId, threadTs }) => {
      if (!deps.runs) return "I cannot stop anything right now.";
      if (!threadTs) return "That only means something inside a thread.";
      const key = `${channelId}:${threadTs}`;
      const running = deps.runs.current(key);
      if (!running) {
        // Said plainly: "nothing is running" and "I could not stop it" are very
        // different things to read when you are watching something misbehave.
        const waiting = deps.runs.inThread(key).length;
        return waiting > 0
          ? `Nothing is running yet - ${waiting} ${waiting === 1 ? "turn is" : "turns are"} waiting behind it.`
          : "Nothing is running in this thread.";
      }
      // Your own turn is yours to stop; someone else's takes an admin, since a
      // turn is their work and often their money.
      if (running.actor !== actor.slackId && RANK[actor.role] < RANK.admin) {
        return `That one is <@${running.actor}>'s, and it has been going ${forHowLong(deps.clock() - running.startedAt)}. Only they or an admin can stop it.`;
      }
      // A stop is a REQUEST. Asking twice must not read as two successful
      // stops - that is the lie the `stopping` state exists to prevent, and
      // this path had it too: the result of `stop` was thrown away and the
      // notice written regardless.
      if (running.state === "stopping") return stillStoppingNotice(running, deps.clock());
      const stopped = deps.runs.stop(running.id, actor.slackId);
      if (!stopped) return "that one finished on its own just now.";
      return stoppedNotice(stopped, actor.slackId, deps.clock());
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
    name: "2fa",
    aliases: ["totp", "otp"],
    minRole: "executer",
    usage: "<label> | list | add <label> | remove <label>",
    summary: "a 2FA code for a shared login I hold the setup key for",
    run: async (ctx) => {
      const { deps, actor, args, slash } = ctx;
      if (!deps.totp) return "2FA storage is not wired up here.";
      const sub = (args[0] ?? "").toLowerCase();

      if (args.length === 0 || sub === "list" || sub === "ls") {
        const held = deps.totp.list();
        if (held.length === 0) {
          return `I hold no setup keys yet. An admin adds one with \`${slash} 2fa add <name>\`.`;
        }
        const lines = held.map(
          (h) => `- \`${h.label}\`${h.account ? ` - ${h.account}` : ""}, added by <@${h.addedBy}> ${since(deps.clock() - h.updatedAt)}`,
        );
        return `${held.length} shared ${held.length === 1 ? "login" : "logins"}. \`${slash} 2fa <name>\` for a code.\n${lines.join("\n")}`;
      }

      if (sub === "add" || sub === "set") {
        if (RANK[actor.role] < RANK.admin) return "Only admins can add a setup key.";
        const label = normaliseLabel(args.slice(1).join(" "));
        if (!label) return `Name it: \`${slash} 2fa add <name>\` - that name is how you ask for a code later.`;
        // Never accept a setup key as command text: a message is readable by
        // everyone in the channel, lands in my memory, and outlives the turn.
        // The box the button opens is not a message.
        const box = await askForSecret(ctx, label);
        const replacing = deps.totp.has(label) ? `\`${label}\` already has a key - this replaces it.\n\n` : "";
        return box ? `${replacing}${box}` : "";
      }

      if (sub === "remove" || sub === "forget" || sub === "delete") {
        if (RANK[actor.role] < RANK.admin) return "Only admins can remove a setup key.";
        const label = normaliseLabel(args.slice(1).join(" "));
        if (!label) return `Which one? \`${slash} 2fa remove <name>\`.`;
        return deps.totp.remove(label)
          ? `Forgotten the setup key for \`${label}\`. Nobody gets a code for it from me now.`
          : `I had no setup key for \`${label}\` anyway.`;
      }

      const label = normaliseLabel(args.join(" "));
      const cfg = deps.totp.get(label);
      if (!cfg) {
        const known = deps.totp.list().map((h) => `\`${h.label}\``);
        return known.length
          ? `No setup key for \`${label}\`. I have ${known.join(", ")}.`
          : `No setup key for \`${label}\`, and I hold none at all yet.`;
      }
      const now = deps.clock();
      const left = secondsLeft(cfg, now);
      // A code with a couple of seconds on it is a code that fails while you are
      // still typing it, so hand over the next one rather than that.
      if (left <= MIN_CODE_SECONDS) {
        const next = totpCode(cfg, now + left * 1000);
        return `\`${next}\` for \`${label}\` - the one on screen right now expires in ${left}s, so this is the next one. Give it ${left}s.`;
      }
      return `\`${totpCode(cfg, now)}\` for \`${label}\`${cfg.account ? ` (${cfg.account})` : ""} - ${left}s left.`;
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

/** Whether this line runs a tool-like command: result to the caller, not the thread. */
export const isQuietCommand = (line: string): boolean => {
  const [first = "", ...args] = line.trim().split(/\s+/);
  const command = byName.get(first.toLowerCase());
  // A help card is a guide for whoever asked. When the brain asks, it reads it
  // for itself: a menu dropped into a conversation is noise nobody wanted.
  if (command && asksForHelp(args)) return true;
  return command?.quiet === true;
};

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
    destructive: c.destructive === true,
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
  // `//bot <pr-url>` is not a typo, it is somebody asking for a review and
  // leaving the verb out. It was typed that way five times and answered with
  // "I do not recognise https://github.com/..." every time. The whole line is
  // then the review's arguments, url included.
  const unnamedReview = !byName.has(name) && (PR_URL.test(name) || /^[\w.-]+\/[\w.-]+#\d+$/.test(name));
  const rest = unnamedReview ? trimmed : trimmed.slice(name.length).trim();
  const args = rest.length ? rest.split(/\s+/) : [];

  const log = (command: string, ok: boolean, result: string) =>
    deps.commandLog?.add({ slackUserId: actor.slackId, command, args: rest, channelId, ok, result }, deps.clock());

  const command = unnamedReview ? byName.get("review") : byName.get(name);
  if (!command) {
    // Name the near miss rather than sending someone to read forty lines to
    // find the word they almost typed. Only commands their role can actually
    // run, so a suggestion is never a door that turns out to be locked.
    const reachable = COMMANDS.filter((c) => RANK[actor.role] >= RANK[c.minRole]).flatMap((c) => [
      c.name,
      ...(c.aliases ?? []),
    ]);
    const near = nearestCommand(name, reachable);
    const msg = near
      ? `I do not recognise \`${name}\`. Did you mean \`${prefix} ${near}\`? \`${prefix} help\` has the rest.`
      : `I do not recognise \`${name}\`. Try \`${prefix} help\`.`;
    log(name, false, msg);
    return msg;
  }
  if (RANK[actor.role] < RANK[command.minRole]) {
    const msg = `That command needs *${command.minRole}* access. You are *${actor.role}*.`;
    log(command.name, false, msg);
    return msg;
  }
  // What it does, without doing it. `ticket help` used to spawn a full
  // host-login ticket run with "help" as the bug report and die at the timeout.
  if (!command.ownHelp && command.name !== "help" && asksForHelp(args)) {
    return commandHelp(
      {
        name: command.name,
        usage: command.usage,
        summary: command.summary,
        minRole: command.minRole,
        aliases: command.aliases,
      },
      prefix,
    );
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
    // A killed run is out of TIME, not broken. "That command failed: claude CLI
    // exited with code 143: no output" reads as a bug and invites the same
    // expensive thing again; saying it ran long invites a narrower one.
    const msg = isTimeout(e)
      ? `\`${command.name}\` ran past its time limit and I killed it, so nothing came back. Narrow it down and try again.`
      : `That command failed: ${e instanceof Error ? e.message : String(e)}`;
    log(command.name, false, msg);
    return msg;
  }
};
