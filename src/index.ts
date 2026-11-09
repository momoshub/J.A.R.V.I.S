/**
 * Composition root.
 *
 * The only place that knows about every layer at once: load config, open the
 * database, build the adapters, wire the use-case dependencies, and start both
 * the Slack listener and the dashboard. Everything below this file is decoupled
 * and independently testable.
 */
// TODO(split): big file, deliberately not refactored in one go. Rule: split the part you
//   touch into its own module; the markers below name where each section should go.
import { writeGuides } from "./infrastructure/system/guideWriter.ts";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, modelLabel, type AppConfig } from "./config/env.ts";
import { isSilenceNote } from "./domain/silence.ts";
import { openDatabase } from "./infrastructure/db/client.ts";
import { createThreadSessionRepo } from "./infrastructure/db/threadSessionRepo.ts";
import { createThreadQueue } from "./application/threadQueue.ts";
import { RESTART_DELAY_MS, RESTART_HOLD_NOTICE, RESTART_MAX_WAIT_MS, restartWhenIdle } from "./domain/selfUpdate.ts";
import { isDbFileSwapped } from "./domain/dbHealth.ts";
import { createRestartCutter, createRunRegistry, drainSettled } from "./application/runRegistry.ts";
import { createSystemProbe, createSystemTracker } from "./infrastructure/system/systemProbe.ts";
import { createTotpRepo } from "./infrastructure/db/totpRepo.ts";
import {
  createClaudeTokenRepo,
  loadOrCreateKey,
  openTokenDatabase,
} from "./infrastructure/db/claudeTokenRepo.ts";
import { createUserRepo } from "./infrastructure/db/userRepo.ts";
import { createMessageRepo } from "./infrastructure/db/messageRepo.ts";
import { createLearningsRepo } from "./infrastructure/db/learningsRepo.ts";
import { createAdapterStore } from "./infrastructure/adapter/adapterStore.ts";
import {
  adapterStatus,
  createAdapterReader,
  editAdapterFile,
  rememberFact,
  revertAdapter,
} from "./application/adapterMemory.ts";
import { createAdapterRevisionRepo } from "./infrastructure/db/adapterRevisionRepo.ts";
import { createCommandLogRepo } from "./infrastructure/db/commandLogRepo.ts";
import { createUsageRepo } from "./infrastructure/db/usageRepo.ts";
import { createStatsRepo } from "./infrastructure/db/statsRepo.ts";
import { createTurnLogRepo } from "./infrastructure/db/turnLogRepo.ts";
import { createWatchRepo } from "./infrastructure/db/watchRepo.ts";
import { createReminderRepo } from "./infrastructure/db/reminderRepo.ts";
import { createFollowRepo } from "./infrastructure/db/followRepo.ts";
import { createKitViewRepo } from "./infrastructure/db/kitViewRepo.ts";
import { createWatcher } from "./application/watcher.ts";
import { createReviewGuard } from "./application/reviewGuard.ts";
import { createReviewInbox } from "./application/reviewInbox.ts";
import { createOrcaQuestionBridge } from "./application/orcaQuestions.ts";
import { createOrcaQuestionRepo } from "./infrastructure/db/orcaQuestionRepo.ts";
import { createGhReviewRequests } from "./infrastructure/github/reviewRequests.ts";
import { createGithubApp, type GithubApp } from "./application/githubApp.ts";
import { createGithubActions, type GithubActions } from "./application/githubAppActions.ts";
import { createGithubAppClient } from "./infrastructure/github/appClient.ts";
import { loadGithubAppCredentials, webhookSecretOf } from "./infrastructure/github/appCredentials.ts";
import { startWebhookServer } from "./infrastructure/github/webhookServer.ts";
import { createGithubAppRepo } from "./infrastructure/db/githubAppRepo.ts";
import { createInnerChild, steerViaRespond } from "./application/innerChild.ts";
import { decideAccess } from "./domain/access.ts";
import { createDriftRepo } from "./infrastructure/db/driftRepo.ts";
import { createSelfIssueRepo } from "./infrastructure/db/selfIssueRepo.ts";
import { NO_TOOLS } from "./domain/toolPolicy.ts";
import { createReminderSender } from "./application/reminders.ts";
import { createShellCheck } from "./infrastructure/system/shellCheck.ts";
import { createOrcaCli, createOrcaTerminal } from "./infrastructure/system/orcaTerminal.ts";
import { createOrcaProbe } from "./infrastructure/system/orcaProbe.ts";
import { measureWorker, runDispatches } from "./infrastructure/system/workerTranscript.ts";
import { createWorkerUsageRepo } from "./infrastructure/db/workerUsageRepo.ts";
import { keepWorkerUsage } from "./application/workerCost.ts";

/** `worker-read` / `worker-show` can be slow on a big transcript; the 5s default is too tight. */
const WORKER_USAGE_ORCA_TIMEOUT_MS = 15_000;

import { createWorkflowRepo } from "./infrastructure/db/workflowRepo.ts";
import { resumeContinues } from "./application/workflowContinue.ts";
import { SIGNATURES } from "./domain/messageFooter.ts";
import { WORKER_BILL_KIND } from "./application/workflow.ts";
import { createAccessRequestRepo } from "./infrastructure/db/accessRequestRepo.ts";
import { createCommandApprovalRepo } from "./infrastructure/db/commandApprovalRepo.ts";
import { createSettingsRepo, modelKey, SETTING_KEYS } from "./infrastructure/db/settingsRepo.ts";
import { agentModelEnv, agentModelsOf, builtinAgentOverrides } from "./domain/agentModels.ts";
import { loadBotProfile } from "./application/botProfile.ts";
import { seedOwner } from "./infrastructure/db/seed.ts";
import { createAnthropicLlm } from "./infrastructure/llm/anthropic.ts";
import { createClaudeCliLlm } from "./infrastructure/llm/claudeCli.ts";
import { WebClient } from "@slack/web-api";
import { createSlackApp } from "./infrastructure/slack/app.ts";
import { createInboxReceiver, tidyInterrupted } from "./infrastructure/slack/inboxReceiver.ts";
import { drainNotice, waitsForRestart } from "./domain/drainNotice.ts";
import { interruptedNotice } from "./domain/inbox.ts";
import { openInbox } from "./infrastructure/inbox/inboxRepo.ts";
import { respond } from "./application/respond.ts";
import type { ConnectionHealth } from "./domain/connectionHealth.ts";
import { createUiAccessProbe } from "./infrastructure/system/uiAccessProbe.ts";
import { describeUiAccess, needsAttention } from "./domain/uiAccess.ts";
import { createSlackAdmin } from "./infrastructure/slack/adminClient.ts";
import { createOfflineAlarmSlack } from "./infrastructure/slack/offlineAlarmClient.ts";
import { createOfflineAlarm } from "./application/offlineAlarm.ts";
import { OFFLINE_ALARM_REQUEST_TIMEOUT_MS, OFFLINE_ALARM_TICK_MS } from "./domain/offlineAlarm.ts";
import { createGhCli } from "./infrastructure/github/ghCli.ts";
import { createDraftReply } from "./application/draftReply.ts";
import { syntheticTs } from "./domain/slackLinks.ts";
import { toolPolicyFor } from "./domain/toolPolicy.ts";
import { roleOf } from "./application/commands/shared.ts";
import { effectivePolicy, policyDisallow } from "./domain/rolePolicy.ts";
import { disabledRoleOf, enforceRolePolicies } from "./application/rolePolicies.ts";
import { createRolePolicyRepo } from "./infrastructure/db/rolePolicyRepo.ts";
import { logSourceOrder } from "./domain/investigation.ts";
import { createDashboard } from "./infrastructure/dashboard/server.ts";
import { runForBrain } from "./application/brainRun.ts";
import { dispatchCommand, isQuietCommand } from "./application/commands.ts";
import { createCommandTickets, refusalMessage } from "./application/commandTickets.ts";
import { createActivityLog } from "./infrastructure/logger.ts";
import type { CommandLogRepo } from "./infrastructure/db/commandLogRepo.ts";
import type { LlmPort, ToolTraceSink, UsageSink } from "./application/ports.ts";
import { createToolTraceLog, readTraceCalls } from "./infrastructure/llm/toolTraceLog.ts";
import { createBackgroundAgents, defaultRunner } from "./infrastructure/llm/backgroundAgents.ts";
import { createStuckWorkProbe } from "./infrastructure/system/stuckWorkProbe.ts";
import { createStuckSweeper } from "./application/stuckSweeper.ts";
import { SWEEP_TICK_MS } from "./domain/stuckWork.ts";
import { teamFromPermalink } from "./domain/mindful.ts";
import type { RespondDeps } from "./application/respond.ts";
import { logAndIgnore } from "./application/ignoredError.ts";

/**
 * Where the CLI runs. Default to a neutral dir outside the bot's own source so she
 * never picks up this repo's git status / CLAUDE.md as "her job" and cannot edit
 * her own code by accident. Override with CLAUDE_CWD to point her at a project.
 */
const ensureDir = (path: string): string => {
  mkdirSync(path, { recursive: true });
  return path;
};

// TODO(split): move buildLlm to src/infrastructure/llm/buildLlm.ts
/** Pick the brain based on config: the local Claude Code CLI or the API. */
const buildLlm = (
  config: AppConfig,
  cwd: string,
  onUsage?: UsageSink,
  onToolTrace?: ToolTraceSink,
  turnEnv?: () => Promise<Record<string, string | undefined>>,
  agents?: () => Record<string, Record<string, unknown>>,
): LlmPort =>
  config.llmProvider === "claude-cli"
    ? createClaudeCliLlm({
        binPath: config.claudeBin,
        model: config.claudeModel,
        skipPermissions: config.claudeSkipPermissions,
        cwd,
        timeoutMs: config.claudeTimeoutMs,
        onUsage,
        onToolTrace,
        turnEnv,
        agents,
      })
    : createAnthropicLlm({
        // guaranteed present for this provider by config validation
        apiKey: config.anthropicApiKey as string,
        model: config.anthropicModel,
      });

/**
 * How long a triggered command may run before the caller is released. Long
 * enough that a quick command still answers inline, short enough that a slow
 * one never outlives the chat turn waiting on it.
 */
const RUN_HANDOFF_MS = 20_000;

/**
 * How often the watcher looks for a due check. Slightly under the fastest
 * interval a watch may ask for, so `--every 15s` is roughly honoured rather
 * than quietly becoming 30.
 */
const WATCH_TICK_MS = 10_000;

const main = async () => {
  const config = loadConfig();

  // TODO(split): move db + repository construction to src/infrastructure/persistence/buildRepos.ts (returns the repo bag)
  const db = openDatabase(config.databasePath);
  // The bot reads its allowlist through the role policies, so a switched-off
  // role grants nothing anywhere; the dashboard alone gets the raw store.
  const userStore = createUserRepo(db);
  const rolePolicies = createRolePolicyRepo(db);
  const users = enforceRolePolicies(userStore, rolePolicies.get);
  const messages = createMessageRepo(db);
  const learnings = createLearningsRepo(db);
  // Memory as a checked, versioned adapter in the database, mirrored to disk.
  // `data/adapter` is where it used to live: imported once, while the table is
  // still empty. With no adapter at all the bot keeps using `learnings`.
  const adapterStore = createAdapterStore(db, config.adapterPath, join(import.meta.dir, "..", "data", "adapter"));
  const adapterRevisions = createAdapterRevisionRepo(db);
  const usage = createUsageRepo(db);
  const turns = createTurnLogRepo(db);
  const watches = createWatchRepo(db);
  const workerUsageRepo = createWorkerUsageRepo(db);
  const reminders = createReminderRepo(db);
  const follows = createFollowRepo(db);
  const kitViews = createKitViewRepo(db);
  const adapterDeps = () => ({
    store: adapterStore,
    revisions: adapterRevisions,
    clock,
    budget: config.adapterBudget,
  });
  const adapterReader = createAdapterReader(adapterStore, (err) =>
    console.error("[adapter] could not load, serving the last good read:", err),
  );
  const settings = createSettingsRepo(db);
  // Separate database on purpose: the main one is committed, and user tokens
  // must never be able to reach git. Encrypted under a key kept beside it.
  const tokenDb = openTokenDatabase(config.tokenDatabasePath);
  const tokenKey = loadOrCreateKey(config.tokenKeyPath);
  const claudeTokens = createClaudeTokenRepo(tokenDb, tokenKey);
  // Shared 2FA seeds live beside the tokens, under the same key: a seed is a
  // credential, so it gets the credential database rather than the committed one.
  const totp = createTotpRepo(tokenDb, tokenKey);
  // Activity log to the logs/ folder: every command (and message) is recorded,
  // failed commands additionally land in errors.log.
  const activity = createActivityLog(config.logDir);
  const workflows = createWorkflowRepo(db);
  // One CLI session per Slack thread, so a follow-up keeps the context the last
  // turn built instead of starting the conversation over.
  const threadSessions = createThreadSessionRepo(db);
  const accessRequests = createAccessRequestRepo(db);
  const commandApprovals = createCommandApprovalRepo(db);
  const commandTickets = createCommandTickets(() => Date.now(), undefined, config.commandTicketUses);
  const baseCommandLog = createCommandLogRepo(db);
  const commandLog: CommandLogRepo = {
    ...baseCommandLog,
    add: (entry, createdAt) => {
      baseCommandLog.add(entry, createdAt);
      const rec = {
        user: entry.slackUserId,
        command: entry.command,
        args: entry.args,
        channel: entry.channelId,
        result: entry.result.slice(0, 300),
      };
      if (entry.ok) activity.event("command", rec);
      else activity.error("command_failed", rec);
    },
  };
  const clock = () => Date.now();

  const disabledCommands = (): ReadonlySet<string> =>
    new Set(
      (settings.get(SETTING_KEYS.disabledCommands) ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

  /** Commands each role's dashboard policy denies, read per call so a save needs no restart. */
  const deniedCommands = (role: Parameters<typeof rolePolicies.get>[0]): ReadonlySet<string> =>
    new Set(effectivePolicy(rolePolicies.get(role)).deniedCommands);

  seedOwner(userStore, config.ownerSlackId, clock);

  // The bot's identity lives in the DB; env values only bootstrap a fresh clone.
  const profile = () =>
    loadBotProfile(settings, {
      name: config.botName,
      thinkingLabel: config.botThinkingLabel,
      thinkingDoneLabel: config.botThinkingDoneLabel,
    });

  // Full-access cwd (owner/admin) is neutral (outside EV's source); sandboxed
  // roles (pal/executer) run in a separate fixed scratch dir.
  const fullCwd = ensureDir(config.claudeCwd ?? join(tmpdir(), "bot-agent-workspace"));
  const sandboxCwd = ensureDir(join(tmpdir(), "bot-sandbox-workspace"));
  // Every role may react, through a helper that can only reach reactions.add -
  // a general `curl` in a sandbox would be an outbound channel for the token.
  const reactScript = join(import.meta.dir, "..", "bin", "slack-react.sh");
  const runScript = join(import.meta.dir, "..", "bin", "jarvis-run.sh");
  const fileScript = join(import.meta.dir, "..", "bin", "slack-file.sh");
  const grafanaGetScript = join(import.meta.dir, "..", "bin", "grafana-get.sh");
  const slackReadScript = join(import.meta.dir, "..", "bin", "slack-read.sh");
  // How `watch reply` asks whether anybody has answered yet.
  const slackWaitScript = join(import.meta.dir, "..", "bin", "slack-wait.sh");
  // How `watch worker` asks whether an Orca worker finished, died or waits for
  // input. Run with this process's own bun: launchd's PATH may not have one.
  const orcaWorkerWait = [process.execPath, join(import.meta.dir, "..", "bin", "orca-worker-wait.ts")];
  // Drives any Mac app through the Accessibility API - no Automation needed.
  const macUiScript = join(import.meta.dir, "..", "bin", "mac-ui.js");
  // The second driver, for every app but Arc. launchd's PATH has no Homebrew,
  // so look there too; absent means it is simply not offered.
  const agentDesktop =
    Bun.which("agent-desktop", { PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` }) ?? undefined;
  // Runs either driver under a desktop-wide lock, so two sessions never click
  // into each other's windows.
  const desktopScript = join(import.meta.dir, "..", "bin", "desktop.ts");
  // Real clicks and keystrokes for web content that ignores AXPress.
  const browserScriptsDir = join(adapterStore.root, "skills", "browser-ui-test", "scripts");
  const browserScripts = ["click.js", "keys.js", "press-exact.js"].map((f) => join(browserScriptsDir, f));
  // Posts a file into a thread, so a sandboxed role can share a screenshot.
  const uploadScript = join(import.meta.dir, "..", "bin", "slack-upload.sh");
  // Reads a claude.ai artifact by opening a full session, which has the tool a
  // `-p` spawn does not.
  const artifactScript = join(import.meta.dir, "..", "bin", "artifact-read.sh");
  const restartScript = join(import.meta.dir, "..", "bin", "jarvis-restart.sh");
  // Posts a turn's answer to the GitHub issue its thread was opened for, as the app.
  const githubCommentScript = join(import.meta.dir, "..", "bin", "github-app-comment.sh");
  const githubAppScript = join(import.meta.dir, "..", "bin", "github-app.sh");
  const repoPath = join(import.meta.dir, "..");
  const stuckWorkProbe = createStuckWorkProbe({
    orca: createOrcaCli(),
    gh: defaultRunner(repoPath),
    traceDir: join(config.logDir, "threads"),
    now: clock,
  });
  // Model per role: a dashboard/command override wins, otherwise the env value,
  // otherwise the adapter default. Read per call so a change needs no restart.
  const modelsForRoles = () => {
    const pick = (role: string, fallback?: string) => settings.get(modelKey(role))?.trim() || fallback;
    return {
      pal: pick("pal", config.claudeModelPal),
      executer: pick("executer"),
      admin: pick("admin"),
      owner: pick("owner"),
    };
  };
  const toolPolicy = (role: Parameters<typeof toolPolicyFor>[0], channelId?: string) =>
    toolPolicyFor(role, {
      channelModel: channelId ? settings.get(modelKey(`channel:${channelId}`)) : undefined,
      fullCwd,
      sandboxCwd,
      reactScript,
      runScript,
      fileScript,
      grafanaGetScript,
      slackReadScript,
      macUiScript,
      agentDesktop,
      desktopScript,
      browserScripts,
      uploadScript,
      githubCommentScript,
      githubAppScript,
      models: modelsForRoles(),
      protectedPaths: [repoPath],
      executerTools: (settings.get(SETTING_KEYS.executerTools) ?? "")
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
      // The role's dashboard policy: denied tools and MCP servers, read per turn.
      roleDisallow: policyDisallow(rolePolicies.get(role)),
      // The host's Notion MCP server writes as the host, like `note`: same floor.
      notionFloor: roleOf(settings.get(SETTING_KEYS.noteMinRole)?.trim().toLowerCase()),
    });

  // Every finished run is recorded: who asked, what for, what it consumed.
  // Accounting is wired HERE rather than inside the adapter so the adapter
  // stays a pure port - it reports, it does not own a database.
  const recordUsage: UsageSink = (u, payer, bill) =>
    usage.add(
      {
        slackUserId: bill?.actor ?? "",
        kind: bill?.kind ?? "chat",
        channelId: bill?.channel ?? "",
        model: u.model,
        payer,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheRead: u.cacheReadTokens,
        cacheWrite: u.cacheWriteTokens,
        costUsd: u.costUsd,
        durationMs: u.durationMs,
      },
      clock(),
    );

  // One file per thread, beside the bot's own logs - what every turn ran, in full.
  const traceLog = createToolTraceLog(join(config.logDir, "threads"));
  // Orca workers a thread starts are linked to it as their launch goes by, so
  // a worker's question can find its way back (the bridge is built below,
  // once there is a turn path to hand questions to).
  let orcaQuestions: { observe: ToolTraceSink } | undefined;
  const toolTrace: ToolTraceSink = (trace, bill) => {
    traceLog(trace, bill);
    orcaQuestions?.observe(trace, bill);
  };
  // The bot's own Orca terminal, so a turn can open Runs and start workers.
  // Every turn gets its handle - or, with Orca down, no handle at all, never
  // one inherited from whatever pane started the bot.
  const orcaTerminal = config.orcaTerminalWorktree
    ? createOrcaTerminal({
        run: createOrcaCli(),
        load: () => settings.get(SETTING_KEYS.orcaTerminalHandle),
        save: (handle) => settings.set(SETTING_KEYS.orcaTerminalHandle, handle),
        worktree: config.orcaTerminalWorktree,
        now: clock,
        log: (line) => console.log(line),
      })
    : undefined;
  // Subagent, Orca worker and Plan models, read per turn like the role models.
  const agentModels = () => agentModelsOf((kind) => settings.get(modelKey(kind)));
  const turnEnv = async () => ({
    ORCA_TERMINAL_HANDLE: await orcaTerminal?.handle(),
    ...agentModelEnv(agentModels()),
  });
  // Checked once at boot, so the first turn does not pay for it.
  void orcaTerminal?.handle();
  const llm = buildLlm(config, fullCwd, recordUsage, toolTrace, turnEnv, () => builtinAgentOverrides(agentModels()));
  console.log(`[llm] ${profile().name}'s brain: ${modelLabel(config)}`);

  // Slack Web API + AI drafting, shared by the console and the power-tool commands.
  // retries: 0 so a rate-limited call fails fast instead of hanging.
  const slackWeb = new WebClient(config.slackBotToken, { retryConfig: { retries: 0 } });
  const slackAdmin = createSlackAdmin(slackWeb, clock);
  const promptContext = () => ({
    botName: profile().name,
    base: settings.get(SETTING_KEYS.systemPrompt),
    learnings: learnings.list().map((l) => l.content),
    adapter: adapterReader.read(),
  });
  const draft = createDraftReply({ llm, promptContext, ownerSlackId: config.ownerSlackId });

  // Filled in once the Slack app exists, so /health and `sys` can report the
  // socket from the moment it does and never trip over the order things are
  // built in.
  let slackApp:
    | {
        health: () => ConnectionHealth;
        inFlight: () => number;
        unbudgetedInFlight: () => number;
        pauseIntake: () => void;
        budgetIntake: (ms: number) => void;
        markCut: () => number;
      }
    | undefined;
  const runs = createRunRegistry();
  // TODO(split): move the system tracker/probe wiring to src/application/systemWiring.ts
  // Vitals, sampled on a timer: a snapshot answers "is it bad now", a short
  // history answers "has it been bad for a while", which is the question
  // someone is really asking when they notice something feels slow.
  const system = createSystemTracker(
    createSystemProbe({
      dataDir: dirname(config.databasePath) || ".",
      socket: () => slackApp?.health().state,
      runs: () => {
        const tracked = runs.all();
        return {
          active: tracked.filter((r) => r.state === "running").length,
          queued: tracked.filter((r) => r.state === "queued").length,
        };
      },
    }),
  );

  const deps: RespondDeps = {
    users,
    messages,
    llm,
    clock,
    ownerSlackId: config.ownerSlackId,
    // Live identity + learnings, editable from the dashboard.
    promptContext,
    // For the command registry (learn/learnings, model/status, log + disable, rv/br/jrp).
    learnings,
    adapterStore,
    adapterRevisions,
    adapterBudget: () => config.adapterBudget,
    botInfo: () => ({ botName: profile().name, model: modelLabel(config) }),
    commandLog,
    usage,
    turns,
    watches,
    follows,
    reminders,
    slackWaitScript,
    orcaWorkerWait,
    workerUsage: {
      measure: (id) => measureWorker(id, { orca: createOrcaCli("orca", WORKER_USAGE_ORCA_TIMEOUT_MS) }),
      dispatchesOf: async (runId) =>
        runDispatches((await createOrcaCli()(["orchestration", "task-list", "--run", runId, "--json"])).stdout),
      repo: workerUsageRepo,
    },
    macUiScript,
    agentDesktop,
    desktopScript,
    // Re-run a dead turn, or nudge a quiet thread, from `mindful`. It goes
    // through the ordinary respond path on purpose: same queue, same session,
    // same role checks - a retry that took a shortcut would not be a retry of
    // the thing that failed.
    runTurn: async ({
      channelId,
      threadTs,
      slackUserId,
      text,
      keepSession,
      autoContinue,
      unprompted,
      workerLane,
    }: {
      channelId: string;
      threadTs: string;
      slackUserId: string;
      text: string;
      keepSession?: boolean;
      autoContinue?: boolean;
      unprompted?: boolean;
      workerLane?: boolean;
    }) => {
      const result = await respond(deps, {
        channelId,
        slackUserId,
        text,
        threadTs,
        messageTs: syntheticTs(clock()),
        viaSlash: false,
        following: false,
        keepSession,
        autoContinue,
        unprompted,
        workerLane,
      });
      // A turn nobody watched live can still answer with a note about not
      // answering; posted, it reads as the whole reply.
      if (result.kind !== "ignored" && result.text.trim() && !isSilenceNote(result.text)) {
        // Signed with what the turn cost, as a reply streamed live would be.
        await slackAdmin.post(
          channelId,
          result.text,
          threadTs,
          result.kind === "reply" ? result.by : undefined,
          result.kind === "reply" ? result.usage : undefined,
        );
      }
    },
    disabledCommands,
    deniedCommands,
    roleDisabled: disabledRoleOf(userStore, rolePolicies.get),
    rawUsers: userStore,
    slack: slackAdmin,
    // `review` approves through this directly, before the brain starts.
    github: createGhCli(),
    // Long tasks driven from a thread, each holding its own CLI session.
    workflows,
    // Failed worker steps in a row, so a timed-out step is retried once.
    stepFailures: new Map<number, number>(),
    // The worker's recent tool calls, from the per-thread trace, for the front's digest.
    workerCalls: (channelId: string, threadTs: string, limit: number) =>
      readTraceCalls(join(config.logDir, "threads"), channelId, threadTs, WORKER_BILL_KIND, limit),
    threadSessions,
    // One turn at a time per thread. Two messages a few minutes apart used to
    // run at once, doing the same work twice - two branches, two PRs - and
    // resuming the same CLI session from two processes while they did it.
    threadQueue: createThreadQueue(),
    // Handles on the turns in flight, so one can be stopped from a button or
    // `stop` instead of being waited out.
    runs,
    // `claude --bg` sessions and Orca workers a thread's turns started, so
    // `stop` ends those too - they live outside the turn's process tree.
    backgroundAgents: createBackgroundAgents({ traceDir: join(config.logDir, "threads"), claudeBin: config.claudeBin }),
    // Orca tasks nobody is working and quiet PRs on this repo, for `mindful`
    // and the sweeper's DM.
    stuckWork: stuckWorkProbe.scan,
    reviewGuard: createReviewGuard(clock),
    system,
    // Orca for `sys`: runtime, Runs and live workers, bounded and never throwing.
    orca: createOrcaProbe({ run: createOrcaCli() }),
    threadSessionsOn: () => settings.get(SETTING_KEYS.threadSessions)?.trim().toLowerCase() !== "off",
    // A stranger is put to the owner for a ✅ / ❌ rather than refused outright.
    accessRequests,
    // A pal out of allowance has their command parked for approval.
    commandApprovals,
    // Per-person allowances live here, set with the `limit` command.
    settings,
    // Where to look for logs, in order. Read per call so a change needs no restart.
    logSources: () => logSourceOrder(settings.get(SETTING_KEYS.logSources)),
    // A bug reported in chat becomes a ticket, but only once there is a tracker.
    canRaiseTickets: () => !!settings.get(SETTING_KEYS.ticketTracker)?.trim(),
    reactScript,
    // The how-to guides a full-access turn reads on demand (promptGuides.ts).
    guideDir: join(import.meta.dir, "..", "data", "prompt-guides"),
    writeGuides,
    fileScript,
    grafanaGetScript,
    slackReadScript,
    artifactScript,
    restartScript,
    repoPath,
    selfPrAccounts: config.selfPrAccounts,
    draft,
    toolPolicy,
    // A person's own Claude Code credential: required by `review`, used by every
    // other turn of theirs when they have one on file.
    claudeTokens,
    totp,
    // The dashboard API is loopback-only, so the brain can save a learning the
    // same way the dashboard does - offered to admins/owner conversations only.
    learnUrl: `http://127.0.0.1:${config.dashboardPort}/api/learnings`,
    runUrl: `http://127.0.0.1:${config.dashboardPort}/api/commands/run`,
    kitUrl: `http://127.0.0.1:${config.dashboardPort}/api/kit/views`,
    commandBudget: () => config.commandTicketUses,
    runScript,
    githubAppScript,
    commandTickets,
    commandPrefix: config.commandPrefix,
    slashCommand: config.slashCommand,
  };

  // Whether the desktop will take orders from us. Probed rather than assumed:
  // the grant is bound to the runtime's path, so upgrading it silently revokes
  // the permission and nothing says so.
  const uiAccess = createUiAccessProbe();
  // TODO(split): move restart/drain state (requestRestart, onDbError) to src/application/restartDrain.ts
  // Exit, and let launchd bring us back. Deferred so the reply that asked
  // for it has landed, and held until no turn is running anywhere.
  // Set once a restart is asked for. From then on timers that start turns
  // hold and pending workflow steps stay on their rows for the next process.
  // New messages are still read, each on a short budget, until the turns from
  // before the request have finished; then the inbox is not read either.
  let draining = false;
  let drainStartedAt = 0;
  // Kept for the notice a waiting thread gets: why, and when it gives up waiting.
  let drainReason = "";
  let drainDeadlineMs = 0;
  deps.draining = () => draining;
  const requestRestart = (reason: string): void => {
    activity.line(`restart requested: ${reason}`);
    if (draining) return;
    draining = true;
    drainReason = reason;
    drainStartedAt = Date.now();
    drainDeadlineMs = drainStartedAt + RESTART_DELAY_MS + RESTART_MAX_WAIT_MS;
    restartWhenIdle({
      // New messages still run, but each on a budget: past it the thread is
      // told to hold on and the turn is cut, to be picked up after.
      onDrain: () => slackApp?.budgetIntake(config.restartTurnBudgetMs),
      // Once nothing from before the request runs, take no new work, so the
      // budgeted turns left are the last and the wait ends within a budget.
      settled: () => drainSettled(runs, slackApp?.unbudgetedInFlight() ?? 0, drainStartedAt),
      onSettled: () => slackApp?.pauseIntake(),
      // The rows still running are redelivered by the next process, at once
      // and on the same session, instead of being judged too old to pick up.
      onForce: () => {
        const cut = slackApp?.markCut() ?? 0;
        activity.line(`restart cut ${cut} turn(s) still running; the next process picks them up again`);
      },
      // An envelope still being handled is work too - a slash command or
      // a button press is not a tracked run, and exiting under it loses it.
      // A background worker does NOT hold it open. It is cut and redelivered
      // on the same session by the next process, so waiting on one buys
      // nothing and costs everybody else their replies for up to the cap.
      isIdle: () =>
        runs.all().filter((r) => !r.background).length === 0 && (slackApp?.inFlight() ?? 0) === 0,
      exit: () => {
        console.log("Restarting on request ...");
        process.exit(0);
      },
      schedule: (fn, ms) => {
        setTimeout(fn, ms).unref?.();
      },
      log: (line) => activity.line(line),
    });
  };
  // The database file was swapped under us (a git operation on the committed
  // DB). Every call on this handle now fails, and only reopening fixes it, so
  // restart once idle instead of crashing the turn that is running.
  let dbRestartAsked = false;
  const onDbError = (e: unknown): void => {
    if (!isDbFileSwapped(e) || dbRestartAsked) return;
    dbRestartAsked = true;
    requestRestart("database file was replaced on disk (SQLITE_IOERR_VNODE)");
  };

  // TODO(split): move dashboard wiring to src/application/dashboardWiring.ts
  // Set once the GitHub App is wired below; the dashboard reaches it through this.
  let githubApp: GithubApp | undefined;
  let githubActions: GithubActions | undefined;
  const dashboard = createDashboard(
    {
      port: config.dashboardPort,
      ownerSlackId: config.ownerSlackId,
      model: modelLabel(config),
      commandPrefix: config.commandPrefix,
      slashCommand: config.slashCommand,
      distDir: join(import.meta.dir, "..", "web", "dist"),
      allowedOrigins: config.dashboardAllowedOrigins,
    },
    {
      // Read through a getter: the Slack app is built after this server, and a
      // bot that cannot hear Slack is down however well /health answers.
      slackHealth: () => slackApp?.health(),
      draining: () => draining,
      // Exit, and let launchd bring us back. Deferred so the reply that asked
      // for it has landed, and held until no turn is running anywhere.
      requestRestart,
      uiAccess: uiAccess.read,
      users: userStore,
      rolePolicies,
      messages,
      learnings,
      kitViews,
      stats: createStatsRepo(db),
      adapter: adapterStore.exists()
        ? {
            status: () => adapterStatus(adapterDeps()),
            view: () => {
              const a = adapterStore.load();
              const bullets = (text: string) => text.split("\n").filter((l) => l.trim().startsWith("-")).length;
              return {
                policy: a.policy,
                notes: a.notes,
                skills: a.skills.map((s) => ({ name: s.name, description: s.description })),
                people: [...a.people.keys()],
                channels: [...a.channels.keys()],
                revisions: adapterRevisions.list(20),
                items: bullets(a.policy) + bullets(a.notes) + a.people.size + a.channels.size + a.skills.length,
              };
            },
            remember: (content, by) => {
              const r = rememberFact(adapterDeps(), content, { kind: "global" }, by);
              return r.ok
                ? { ok: true, warnings: r.warnings }
                : { ok: false, violations: r.violations };
            },
            revert: (id, by) => {
              const r = revertAdapter(adapterDeps(), id, by);
              return r.ok ? { ok: true } : { ok: false, violations: r.violations };
            },
            files: () => [...adapterStore.files()].map(([path, content]) => ({ path, content })),
            edit: (path, content, by, base) => {
              const r = editAdapterFile(adapterDeps(), path, content, by, base);
              return r.ok ? { ok: true, warnings: r.warnings } : { ok: false, violations: r.violations };
            },
          }
        : undefined,
      settings,
      clock,
      profile,
      // Console: manage the bot's live Slack messages, with AI-drafted replies.
      slack: slackAdmin,
      draft,
      commandLog,
      usage,
      // Lets the brain run a real command when a chat request is really one.
      // The actor's own role decides what is allowed - nothing is elevated by
      // going through here.
      runCommand: async ({ ticket, line }) => {
        const resolved = commandTickets.redeem(ticket);
        if (!resolved.ok) throw new Error(refusalMessage(resolved.reason, resolved.limit));
        const ctx = resolved.ctx;
        const user = users.get(ctx.actor);
        if (!user) throw new Error("whoever asked is not on the access list");

        const opts = { prefix: config.commandPrefix, slash: config.slashCommand, threadTs: ctx.threadTs };
        return runForBrain({
          quiet: isQuietCommand(line),
          start: (reply) => dispatchCommand(deps, user, ctx.channel, line, reply ? { ...opts, reply } : opts),
          post: async (text) => void (await slackAdmin.post(ctx.channel, text, ctx.threadTs, SIGNATURES.command)),
          handoffMs: RUN_HANDOFF_MS,
          onLateError: (e) => activity.error("command_failed", { command: line, result: String(e) }),
        });
      },
      // A GitHub-called turn answers on GitHub. The ticket names the thread,
      // and the thread decides which issue may be written - never the turn.
      githubComment: async ({ ticket, repo, number, body }) => {
        if (!githubApp) throw new Error("the GitHub App is not configured");
        const resolved = commandTickets.redeem(ticket);
        if (!resolved.ok) throw new Error(refusalMessage(resolved.reason, resolved.limit));
        const url = await githubApp.commentFromTurn({
          channelId: resolved.ctx.channel,
          threadTs: resolved.ctx.threadTs,
          repo,
          number,
          body,
        });
        return url ? { url } : {};
      },
      // The app's full capability, behind the admin role of the ticket's actor.
      githubAction: async (req) => {
        if (!githubActions) throw new Error("the GitHub App is not configured");
        return { ...(await githubActions.run(req)) };
      },
    },
  );
  dashboard.start();

  // With a gateway, Slack traffic arrives through its inbox and the socket is
  // not ours to open - a restart here then costs a short wait, not lost messages.
  // The one drain notice in the log channel, edited as more threads wait.
  // The log channel (#jarvis_logs): restart notice, voice drift, stop presses.
  const logChannel = (): string => config.drainNoticeChannel ?? "";
  let drainPost: { channel: string; ts: string } | undefined;
  let drainPosting: Promise<void> = Promise.resolve();
  const inbox = config.slackTransport === "inbox" ? openInbox(config.inboxDatabasePath) : undefined;
  const slack = createSlackApp(
    {
      inbox: inbox
        ? createInboxReceiver({
            inbox,
            log: (l) => activity.line(`inbox: ${l}`),
            // A turn that started while a restart waits ran past its budget:
            // cut it and tell its thread once; the next process picks it up.
            onOverBudget: createRestartCutter(
              runs,
              (channelId, text, threadTs) => void slackAdmin.post(channelId, text, threadTs).catch(logAndIgnore("restart cut notice")),
              RESTART_HOLD_NOTICE,
            ),
            // Commands, slash commands and buttons cannot be cut at a budget,
            // so while a restart waits they stay in the inbox for the next process.
            waitsForRestart: (row) => waitsForRestart(row.type, row.body, [config.commandPrefix, "!"]),
            onInterrupted: (row) =>
              tidyInterrupted(slackWeb, row, interruptedNotice(row.outcome, row.retried), (l) => activity.line(`inbox: ${l}`)),
            // Somebody wrote in while a restart holds the intake. Their
            // message is safe, but silence reads as death - so the log
            // channel gets one message listing every waiting thread.
            onDeferred: (waiting) => {
              const channel = logChannel();
              if (!channel) return;
              drainPosting = drainPosting
                .then(async () => {
                  const links = await Promise.all(
                    waiting.map(
                      async (w) =>
                        (w.threadTs ? await slackAdmin.permalink?.(w.channel, w.threadTs) : undefined) ?? `<#${w.channel}>`,
                    ),
                  );
                  const text = drainNotice(
                    {
                      reason: drainReason,
                      running: runs.all().filter((r) => !r.background).length,
                      deadlineMs: drainDeadlineMs,
                    },
                    links,
                  );
                  if (drainPost) await slackAdmin.update(drainPost.channel, drainPost.ts, text);
                  else drainPost = (await slackAdmin.post(channel, text)) ?? undefined;
                })
                .catch(logAndIgnore("drain notice post"));
            },
          })
        : undefined,
      botToken: config.slackBotToken,
      appToken: config.slackAppToken,
      streamUpdates: config.slackStreamUpdates,
      botName: profile().name,
      thinkingLabel: () => profile().thinkingLabel,
      thinkingDoneLabel: () => profile().thinkingDoneLabel,
      commandPrefix: config.commandPrefix,
      slashCommand: config.slashCommand,
    },
    { ...deps, kitViews, log: activity.line, stopLogChannel: logChannel },
  );
  slackApp = slack;
  await slack.start();

  // Said at boot, where someone will see it, and loudly when it is missing.
  void uiAccess.read().then(({ access }) => {
    // Both: the runtime this process is, and the CLI it spawns the brain as.
    // The permission attaches to whichever the system holds responsible, and
    // granting only one is how this looked fixed while still being refused.
    const line = describeUiAccess(access, process.execPath, Bun.which(config.claudeBin) ?? config.claudeBin);
    if (needsAttention(access)) activity.error("ui_access", { msg: line });
    console.log(`[ui] ${line}`);
  });

  // TODO(split): move watcher, orca bridge and reminder sender wiring to src/application/watchWiring.ts
  // The thing that actually waits. It polls outside every turn and session, so
  // a thread waiting on a build is not a thread that has stopped working - and
  // a turn that said it would carry on afterwards now does.
  const watcher = createWatcher({
    watches,
    clock,
    check: createShellCheck(fullCwd),
    runTurn: deps.runTurn!,
    say: async (channel, text, thread) => void (await slackAdmin.post(channel, text, thread, SIGNATURES.watch)),
    // The enforced allowlist: a switched-off role's shell watches stop with it.
    mayRun: (id) => id === config.ownerSlackId || !!users.get(id),
    log: (msg) => console.error(`[watch] ${msg}`),
    // A `watch worker` that fired printed the worker's usage; keep it.
    onFired: keepWorkerUsage(workerUsageRepo, orcaWorkerWait[1] ?? "", clock),
    onError: onDbError,
  });
  // A worker's `orca orchestration ask` lands in the bot's own Orca terminal,
  // which nobody reads. This puts each one to the thread that started the
  // worker, as a turn that answers it with `orca orchestration reply`.
  const orcaBridge = orcaTerminal
    ? createOrcaQuestionBridge({
        repo: createOrcaQuestionRepo(db),
        clock,
        orca: createOrcaCli(),
        ready: async () => !!(await orcaTerminal.handle()),
        runTurn: deps.runTurn!,
        mayRun: (id) => id === config.ownerSlackId || !!users.get(id),
        log: (msg) => console.error(`[orca-questions] ${msg}`),
        onError: onDbError,
      })
    : undefined;
  orcaQuestions = orcaBridge;
  // Reminders ride the same timer: they need no model either, only a post.
  const reminderSender = createReminderSender({
    reminders,
    clock,
    post: async (channel, text, thread) => void (await slackAdmin.post(channel, text, thread, SIGNATURES.reminder)),
    log: (msg) => console.error(`[remind] ${msg}`),
    onError: onDbError,
  });
  // GitHub review requests of the bot's account, posted and reviewed in a
  // channel as whoever asked - on their own token, review before approve.
  const ghRequests = createGhReviewRequests();
  const reviewInbox = createReviewInbox({
    clock,
    settings,
    channel: () => settings.get(SETTING_KEYS.reviewInboxChannel) ?? "",
    cursorKey: SETTING_KEYS.reviewInboxCursor,
    requests: ghRequests.requests,
    account: async () => (await deps.github?.whoami())?.login,
    githubName: ghRequests.githubName,
    users,
    hasToken: (id) => claudeTokens.has(id),
    post: async (channel, text, thread) => (await slackAdmin.post(channel, text, thread, SIGNATURES.reviewInbox))?.ts,
    runReview: async ({ actor, channelId, threadTs, line }) => {
      const reply = async (text: string) => void (await slackAdmin.post(channelId, text, threadTs, SIGNATURES.reviewInbox));
      const out = await dispatchCommand(deps, actor, channelId, line, {
        prefix: config.commandPrefix,
        slash: config.slashCommand,
        threadTs,
        reply,
      });
      if (out.trim()) await reply(out);
    },
    prefix: config.commandPrefix,
    log: (msg) => console.error(`[review-inbox] ${msg}`),
  });
  // TODO(split): move GitHub App webhook and review-inbox wiring to src/application/githubWiring.ts
  // Calls from GitHub (a mention of the app, or its label) over a loopback
  // webhook that Tailscale Funnel exposes. Off unless the app's id, key and
  // webhook secret are all on disk / in env.
  const appCreds = loadGithubAppCredentials(config.githubApp);
  let webhookServer: { stop: () => void } | undefined;
  if (appCreds.ok) {
    const creds = appCreds.creds;
    const appClient = createGithubAppClient({
      appId: creds.appId,
      privateKey: creds.privateKey,
      userAgent: config.githubApp.slug || "github-app",
    });
    const app = createGithubApp({
      clock,
      repo: createGithubAppRepo(db),
      github: appClient,
      slug: config.githubApp.slug,
      label: config.githubApp.label,
      allowedOwners: config.githubApp.allowedOwners,
      channel: () =>
        settings.get(SETTING_KEYS.githubAppChannel)?.trim() || settings.get(SETTING_KEYS.reviewInboxChannel)?.trim() || "",
      settings,
      users,
      post: async (channel, text, thread) => (await slackAdmin.post(channel, text, thread, SIGNATURES.githubApp))?.ts,
      // The ordinary respond path as the caller: same queue, session, role
      // and token. Its reply goes in the thread like any turn's, and back to
      // the caller so a turn that never used the helper is still answered.
      runTurn: async ({ actor, channelId, threadTs, text }) => {
        const result = await respond(deps, {
          channelId,
          slackUserId: actor.slackId,
          text,
          threadTs,
          messageTs: syntheticTs(clock()),
          viaSlash: false,
          following: false,
        });
        if (result.kind === "ignored") return "";
        if (result.text.trim() && !isSilenceNote(result.text)) {
          await slackAdmin.post(channelId, result.text, threadTs, SIGNATURES.githubApp);
        }
        return result.text;
      },
      helperPath: githubCommentScript,
      prefix: config.commandPrefix,
      draining: () => draining,
      log: (msg) => console.error(`[github-app] ${msg}`),
    });
    githubApp = app;
    githubActions = createGithubActions({
      clock,
      resolve: (ticket) => {
        const resolved = commandTickets.redeem(ticket);
        if (!resolved.ok) throw new Error(refusalMessage(resolved.reason, resolved.limit));
        return { actor: resolved.ctx.actor, channel: resolved.ctx.channel };
      },
      users,
      github: appClient,
      audit: commandLog,
      allowedOwners: config.githubApp.allowedOwners,
      slug: config.githubApp.slug,
    });
    app.recover();
    webhookServer = startWebhookServer({
      port: config.githubApp.port,
      secret: () => webhookSecretOf(creds),
      onDelivery: app.receive,
      log: (msg) => console.error(`[github-app] ${msg}`),
    });
    console.log(`[github-app] listening on 127.0.0.1:${config.githubApp.port} as @${config.githubApp.slug}`);
  } else {
    console.log(`[github-app] off - missing ${appCreds.missing.join(", ")}`);
  }
  const pendingReminders = reminders.waiting().length;
  if (pendingReminders > 0) console.log(`[remind] ${pendingReminders} reminder(s) waiting from before the restart`);
  // Workflows a restart caught between two steps carry on where they were.
  const resumed = resumeContinues(deps, 15_000);
  if (resumed > 0) console.log(`[workflow] resuming ${resumed} workflow(s) that were mid-way between steps`);
  const waiting = watches.waiting().length;
  if (waiting > 0) console.log(`[watch] carrying on with ${waiting} watch(es) from before the restart`);
  // The inner child: watches the bot's own turns and fixes the bot in its
  // channel, announced before and after. Off until a channel is set.
  const innerChildChannel = () => settings.get(SETTING_KEYS.innerChildChannel)?.trim() ?? "";
  const innerChild = createInnerChild({
    turns,
    messages,
    issues: createSelfIssueRepo(db),
    llm,
    clock,
    get channelId() {
      return innerChildChannel();
    },
    ownerSlackId: config.ownerSlackId,
    botName: () => profile().name,
    sourceDir: repoPath,
    restartScript,
    selfPrAccounts: config.selfPrAccounts,
    noTools: NO_TOOLS,
    enabled: () =>
      !!innerChildChannel() && settings.get(SETTING_KEYS.innerChild)?.trim().toLowerCase() !== "off",
    cursor: {
      get: () => {
        const v = Number(settings.get(SETTING_KEYS.innerChildCursor));
        return Number.isFinite(v) && v > 0 ? v : undefined;
      },
      set: (at) => settings.set(SETTING_KEYS.innerChildCursor, String(at)),
    },
    post: async (channel, text, thread) => (await slackAdmin.post(channel, text, thread, SIGNATURES.innerChild)) ?? undefined,
    // The ordinary respond path, as the owner: same queue, same session, same
    // full access a fix needs. Its reply is posted like any turn's.
    runFix: async ({ channelId, threadTs, slackUserId, text }) => {
      const result = await respond(deps, {
        channelId,
        slackUserId,
        text,
        threadTs,
        messageTs: syntheticTs(clock()),
        viaSlash: false,
        following: false,
      });
      if (result.kind === "ignored") return "";
      if (result.text.trim()) await slackAdmin.post(channelId, result.text, threadTs, SIGNATURES.innerChild);
      return result.text;
    },
    // Voice drift: a nudge run in the drifted thread as whoever that turn
    // answered (their role, their session), never posted there. Only its
    // reply is, unless it is a silence note.
    drift: {
      events: createDriftRepo(db),
      logChannel: () => {
        const v = settings.get(SETTING_KEYS.innerChildDriftChannel)?.trim() ?? "";
        if (v.toLowerCase() === "off") return "";
        return v || logChannel();
      },
      replies: (channel, threadTs) => slackAdmin.replies(channel, threadTs),
      workflowActive: (channel, threadTs) => !!workflows.activeFor(channel, threadTs),
      steer: steerViaRespond({
        run: ({ channelId, threadTs, slackUserId, text }) =>
          respond(deps, {
            channelId,
            slackUserId,
            text,
            threadTs,
            messageTs: syntheticTs(clock()),
            viaSlash: false,
            following: false,
            keepSession: true,
            unprompted: true,
          }),
        post: (channel, text, threadTs) => slackAdmin.post(channel, text, threadTs, SIGNATURES.innerChild),
        workflowActive: (channel, threadTs) => !!workflows.activeFor(channel, threadTs),
        allowed: (id) => decideAccess(id, config.ownerSlackId, users.get).allowed,
      }),
      activity: (event, data) => activity.event(event, data),
    },
    log: (msg) => console.error(`[inner-child] ${msg}`),
  });
  // TODO(split): move the timers (watch tick, stuck sweeper, offline alarm) and shutdown to src/application/timers.ts
  // A rejection on a bare timer is unhandled, and an unhandled rejection kills
  // the process - mid-turn, for whoever is talking to the bot. Never let one out.
  const tickFailed = (name: string) => (e: unknown): void => {
    console.error(`[${name}] tick failed: ${e instanceof Error ? e.message : String(e)}`);
    onDbError(e);
  };
  const watchTimer = setInterval(() => {
    void reminderSender.tick().catch(tickFailed("remind"));
    // These start turns. While a restart waits they hold: watches and review
    // requests stay on their rows, and the next process carries on with them.
    if (draining) return;
    void watcher.tick().catch(tickFailed("watch"));
    void innerChild.tick().catch(tickFailed("inner-child"));
    void reviewInbox.tick().catch(tickFailed("review-inbox"));
    // Questions Orca workers are blocked on, put to the threads that started them.
    void orcaBridge?.tick().catch(tickFailed("orca-questions"));
    // Calls that arrived while a restart drained, or a previous process left.
    void githubApp?.tick().catch(tickFailed("github-app"));
  }, WATCH_TICK_MS);
  (watchTimer as { unref?: () => void }).unref?.();

  // Stuck work nobody is moving - a dispatched Orca task whose worker is gone,
  // a PR on this repo with nothing new for 30 min - DMed to the owner every
  // 15 min, each item at most once in a few hours. Starts no turn, so it keeps
  // sweeping while a restart drains; the first sweep is a minute after boot,
  // since restarts come more often than every 15 min.
  const stuckSweeper = createStuckSweeper({
    clock,
    scan: stuckWorkProbe.scan,
    settings,
    seenKey: SETTING_KEYS.stuckSweepSeen,
    ownerSlackId: config.ownerSlackId,
    postDm: (user, text) => slackAdmin.postDm(user, text, SIGNATURES.stuckSweeper),
    team: async (work) => {
      const anchor = work.tasks.find((t) => t.owner)?.owner ?? work.prs.find((p) => p.owner)?.owner;
      return anchor && slackAdmin.permalink
        ? teamFromPermalink(await slackAdmin.permalink(anchor.channelId, anchor.threadTs))
        : undefined;
    },
    prefix: config.commandPrefix,
    log: (msg) => console.error(`[stuck-sweep] ${msg}`),
  });
  const firstSweep = setTimeout(() => void stuckSweeper.tick(), 60_000);
  const sweepTimer = setInterval(() => void stuckSweeper.tick(), SWEEP_TICK_MS);
  (firstSweep as { unref?: () => void }).unref?.();
  (sweepTimer as { unref?: () => void }).unref?.();

  // Dead man's switch for the host's flaky connection: keeps an "I'm offline"
  // notice armed on Slack's side, so an outage gets reported even though the
  // host cannot reach Slack to say so. Runs while draining too - a restart is
  // not an outage, and letting it lapse would make it look like one.
  const alarmChannel = config.offlineAlarmChannel;
  const offlineAlarm = alarmChannel
    ? createOfflineAlarm({
        channel: alarmChannel,
        slack: createOfflineAlarmSlack(
          new WebClient(config.slackBotToken, {
            retryConfig: { retries: 0 },
            timeout: OFFLINE_ALARM_REQUEST_TIMEOUT_MS,
            // A 429 would otherwise sleep out retry-after, which the timeout does not cover.
            rejectRateLimitedCalls: true,
          }),
        ),
        clock: Date.now,
        log: (l) => console.error(`[offline-alarm] ${l}`),
      })
    : undefined;
  void offlineAlarm?.tick();
  const alarmTimer = offlineAlarm ? setInterval(() => void offlineAlarm.tick(), OFFLINE_ALARM_TICK_MS) : undefined;
  (alarmTimer as { unref?: () => void } | undefined)?.unref?.();

  const shutdown = async () => {
    console.log("\nShutting down ...");
    clearInterval(watchTimer);
    clearTimeout(firstSweep);
    clearInterval(sweepTimer);
    clearInterval(alarmTimer);
    // A deliberate stop is not an outage. This covers `launchctl kickstart -k`
    // and a Mac shutting down or logging out too (all SIGTERM): a few unarmed
    // seconds before the next process re-arms, and no notice for a shutdown.
    // `jarvis-restart.sh` exits without it, and the next process cancels the leftover.
    await offlineAlarm?.disarm();
    dashboard.stop();
    webhookServer?.stop();
    await slack.stop();
    inbox?.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

main().catch((err) => {
  console.error("the bot failed to start:", err);
  process.exit(1);
});
