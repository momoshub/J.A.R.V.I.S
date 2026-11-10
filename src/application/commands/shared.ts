/** Shared types and helpers for the command registry and its groups. */

import type { ReviewGuard } from "../reviewGuard.ts";
import type { WorkerUsagePort } from "../workerCost.ts";
import { DEFAULT_BOT_NAME } from "../../domain/personality.ts";
import { ALWAYS_ON_BUDGET } from "../../domain/adapterCheck.ts";
import { type AdapterDeps } from "../adapterMemory.ts";
import type { SystemTracker } from "../../infrastructure/system/systemProbe.ts";
import type { OrcaProbe } from "../../infrastructure/system/orcaProbe.ts";
import type { AdapterStore } from "../../infrastructure/adapter/adapterStore.ts";
import type { AdapterRevisionRepo } from "../../infrastructure/db/adapterRevisionRepo.ts";
import { asAgentCap, DEFAULT_REVIEW_AGENTS } from "../../domain/reviewPrompt.ts";
import { mentionedId } from "../../domain/mentions.ts";
import { encodeRequest, TOKEN_ACTION, type ClaudeTokenPort } from "../claudeTokens.ts";
import { tokenGuide, tokenWhy } from "../../domain/claudeToken.ts";
import { SIGNATURES } from "../../domain/messageFooter.ts";
import { type TotpPort } from "../totp.ts";
import type { RunRegistry } from "../runRegistry.ts";
import type { ThreadQueue } from "../threadQueue.ts";
import type { ThreadSessionRepo } from "../../infrastructure/db/threadSessionRepo.ts";
import type { AllowedUser, PromptContext, UserRole } from "../../domain/types.ts";
import { type ToolPolicy } from "../../domain/toolPolicy.ts";
import type { BackgroundAgentsPort, Clock, LlmPort } from "../ports.ts";
import type { SlackAdminPort } from "../slackAdmin.ts";
import type { GitHubPort } from "../github.ts";
import type { DraftReply } from "../draftReply.ts";
import type { MessageRepo } from "../../infrastructure/db/messageRepo.ts";
import type { UserRepo } from "../../infrastructure/db/userRepo.ts";
import type { LearningsRepo } from "../../infrastructure/db/learningsRepo.ts";
import type { CommandLogRepo } from "../../infrastructure/db/commandLogRepo.ts";
import type { UsageRepo } from "../../infrastructure/db/usageRepo.ts";
import type { TurnLogRepo } from "../../infrastructure/db/turnLogRepo.ts";
import type { WatchRepo } from "../../infrastructure/db/watchRepo.ts";
import type { ReminderRepo } from "../../infrastructure/db/reminderRepo.ts";
import type { StuckWork } from "../../domain/stuckWork.ts";
import type { FollowRepo } from "../../infrastructure/db/followRepo.ts";
import type { WorkflowRepo } from "../../infrastructure/db/workflowRepo.ts";
import type { CommandApprovalRepo } from "../../infrastructure/db/commandApprovalRepo.ts";
import type { CloudwatchDeps } from "../cloudwatch.ts";
import { SETTING_KEYS, type SettingsRepo } from "../../infrastructure/db/settingsRepo.ts";
import { logAndIgnore } from "../ignoredError.ts";

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
  /** Orca's runtime, Runs and workers for `sys`; absent leaves the section out. */
  orca?: OrcaProbe;
  /** Absolute path of the claude.ai artifact reader, for `read`. */
  artifactScript?: string;
  /** Absolute path of the "has anything new been said" helper, for `watch reply`. */
  slackWaitScript?: string;
  /** The command that runs `bin/orca-worker-wait.ts` (bun + script), for `watch worker`. */
  orcaWorkerWait?: readonly string[];
  /** Measures what an Orca worker used, for `worker-cost`. */
  workerUsage?: WorkerUsagePort;
  llm?: LlmPort;
  promptContext?: () => PromptContext;
  botInfo?: () => { botName: string; model: string };
  commandLog?: CommandLogRepo;
  /** Names of disabled commands (managed from the dashboard). */
  disabledCommands?: () => ReadonlySet<string>;
  /**
   * Commands a role is denied by its dashboard policy, on top of `minRole`.
   * Absent means none. The owner is never denied anything (`rolePolicy.ts`).
   */
  deniedCommands?: (role: UserRole) => ReadonlySet<string>;
  /**
   * The allowlist WITHOUT role policies applied. `users` hides members of a
   * switched-off role, which is right for every actor check - but the commands
   * that manage people (add, remove, promote, demote, users, snub) must still
   * see them as the record they are. Absent: the same as `users`.
   */
  rawUsers?: UserRepo;
  /** What each run of the model consumed, for `spend` and the dashboard. */
  usage?: UsageRepo;
  /** How each turn ended, for `mindful` and for continuing a failed thread. */
  turns?: TurnLogRepo;
  /** Things the bot is waiting for, polled outside any turn. */
  watches?: WatchRepo;
  /** Threads it was asked to keep up with, tag or no tag. */
  follows?: FollowRepo;
  /** Reminders people asked for, posted on a timer outside any turn. */
  reminders?: ReminderRepo;
  /** Minutes east of UTC that reminder times are read in. Defaults to the host's. */
  tzOffsetMinutes?: () => number;
  /** Dispatched Orca tasks with no live worker and quiet PRs on the bot's own repo, for `mindful`. */
  stuckWork?: () => Promise<StuckWork>;
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
    /** Resume the thread's session even if its rules changed since. */
    keepSession?: boolean;
    /** A workflow step the bot started itself, not a human message. */
    autoContinue?: boolean;
    /** Started by the bot, nobody typed it. */
    unprompted?: boolean;
  }) => Promise<void>;
  /** Timer for a workflow's next step; injected so tests need not wait. */
  continueTimer?: (fn: () => void, ms: number) => void;
  /** Failed workflow steps in a row, per workflow id, so a failure is retried once. */
  stepFailures?: Map<number, number>;
  /** Slack Web API operations, for the power tools (bomb, reply). */
  slack?: SlackAdminPort;
  /** GitHub actions the bot takes itself - the up-front approve in `review`. */
  github?: GitHubPort;
  /** Long-running workflow sessions bound to a thread. */
  workflows?: WorkflowRepo;
  /** Fresh CLI session id for a new workflow; injected for deterministic tests. */
  newSessionId?: () => string;
  /** CloudWatch Logs Insights, for `cloudwatch`: the AWS port, the audit repo, the Confirm flow. */
  cloudwatch?: CloudwatchDeps;
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
  /** What a thread's turns left running outside their own process, for `stop`. */
  backgroundAgents?: BackgroundAgentsPort;
  /** Per-thread turn queue; a workflow's first step takes its place in it. */
  threadQueue?: ThreadQueue;
  /** One review per PR at a time, across the review inbox and `review`. */
  reviewGuard?: ReviewGuard;
  /** Read-only Grafana helper, so an investigation can reach a non-Loki datasource. */
  grafanaGetScript?: string;
  /** One CLI session per thread, for the `session` command to inspect and reset. */
  threadSessions?: ThreadSessionRepo;
  threadSessionsOn?: () => boolean;
  clock: Clock;
  ownerSlackId: string;
};

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

export type Context = {
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
  /** Names of the trivial commands. Handed in so a group never imports the registry back. */
  trivialCommands: readonly string[];
};

/** A github PR url, for pulling the target out of a tool-call title. */
export const PR_URL = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

export type CommandDef = {
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
   * A function decides per call, for a command quiet in only some forms.
   */
  quiet?: boolean | ((args: string[]) => boolean);
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
export const adapterDepsOf = (deps: CommandDeps): AdapterDeps | undefined =>
  deps.adapterStore?.exists()
    ? {
        store: deps.adapterStore,
        revisions: deps.adapterRevisions,
        clock: deps.clock,
        budget: deps.adapterBudget?.() ?? ALWAYS_ON_BUDGET,
      }
    : undefined;

export const RANK: Record<UserRole, number> = { pal: 0, executer: 1, admin: 2, owner: 3 };
export const LEADING_MENTION = /^<@[A-Z0-9]+(?::[^>]+|\|[^>]+)?>\s*/;

/** One definition of what a mentioned user looks like, shared with the transport. */
export const slackIdOf = (token?: string): string | undefined => mentionedId(token);

export const roleOf = (token?: string): UserRole | undefined =>
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
export const askForToken = async (ctx: Context, line: string, force = false): Promise<string> => {
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
        SIGNATURES.command,
      )
      .catch(logAndIgnore("command reply post"));
    if (posted) {
      deps.claudeTokens?.markAsked(actor.slackId);
      return "";
    }
  }
  return `${ask}\n\nrun \`${slash} token\` and a box will open for it`;
};

/** Rough age of something, for a list nobody reads timestamps out of. */
export const since = (ms: number): string => {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return mins <= 1 ? "just now" : `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
};

/** How many child agents a review may fan out to, defaulting when unset. */
export const reviewAgentsOf = (deps: CommandDeps): number =>
  asAgentCap(deps.settings?.get(SETTING_KEYS.reviewAgents)) ?? DEFAULT_REVIEW_AGENTS;

export const botNameOf = (deps: CommandDeps): string =>
  deps.botInfo?.().botName ?? deps.promptContext?.().botName ?? DEFAULT_BOT_NAME;

/** The allowlist as a record, role policies NOT applied - for targets, never actors. */
export const recordsOf = (deps: CommandDeps): UserRepo => deps.rawUsers ?? deps.users;
