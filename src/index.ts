/**
 * Composition root.
 *
 * The only place that knows about every layer at once: load config, open the
 * database, build the adapters, wire the use-case dependencies, and start both
 * the Slack listener and the dashboard. Everything below this file is decoupled
 * and independently testable.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, modelLabel, type AppConfig } from "./config/env.ts";
import { openDatabase } from "./infrastructure/db/client.ts";
import { createThreadSessionRepo } from "./infrastructure/db/threadSessionRepo.ts";
import { createThreadQueue } from "./application/threadQueue.ts";
import { restartWhenIdle } from "./domain/selfUpdate.ts";
import { isDbFileSwapped } from "./domain/dbHealth.ts";
import { createRunRegistry } from "./application/runRegistry.ts";
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
  rememberFact,
  revertAdapter,
} from "./application/adapterMemory.ts";
import { createAdapterRevisionRepo } from "./infrastructure/db/adapterRevisionRepo.ts";
import { createCommandLogRepo } from "./infrastructure/db/commandLogRepo.ts";
import { createUsageRepo } from "./infrastructure/db/usageRepo.ts";
import { createTurnLogRepo } from "./infrastructure/db/turnLogRepo.ts";
import { createWatchRepo } from "./infrastructure/db/watchRepo.ts";
import { createReminderRepo } from "./infrastructure/db/reminderRepo.ts";
import { createFollowRepo } from "./infrastructure/db/followRepo.ts";
import { createKitViewRepo } from "./infrastructure/db/kitViewRepo.ts";
import { createWatcher } from "./application/watcher.ts";
import { createReviewGuard } from "./application/reviewGuard.ts";
import { createReviewInbox } from "./application/reviewInbox.ts";
import { createGhReviewRequests } from "./infrastructure/github/reviewRequests.ts";
import { createInnerChild } from "./application/innerChild.ts";
import { createSelfIssueRepo } from "./infrastructure/db/selfIssueRepo.ts";
import { NO_TOOLS } from "./domain/toolPolicy.ts";
import { createReminderSender } from "./application/reminders.ts";
import { createShellCheck } from "./infrastructure/system/shellCheck.ts";

import { createWorkflowRepo } from "./infrastructure/db/workflowRepo.ts";
import { createAccessRequestRepo } from "./infrastructure/db/accessRequestRepo.ts";
import { createCommandApprovalRepo } from "./infrastructure/db/commandApprovalRepo.ts";
import { createSettingsRepo, modelKey, SETTING_KEYS } from "./infrastructure/db/settingsRepo.ts";
import { loadBotProfile } from "./application/botProfile.ts";
import { seedOwner } from "./infrastructure/db/seed.ts";
import { createAnthropicLlm } from "./infrastructure/llm/anthropic.ts";
import { createClaudeCliLlm } from "./infrastructure/llm/claudeCli.ts";
import { WebClient } from "@slack/web-api";
import { createSlackApp } from "./infrastructure/slack/app.ts";
import { createInboxReceiver, tidyInterrupted } from "./infrastructure/slack/inboxReceiver.ts";
import { interruptedNotice } from "./domain/inbox.ts";
import { openInbox } from "./infrastructure/inbox/inboxRepo.ts";
import { respond } from "./application/respond.ts";
import type { ConnectionHealth } from "./domain/connectionHealth.ts";
import { createUiAccessProbe } from "./infrastructure/system/uiAccessProbe.ts";
import { describeUiAccess, needsAttention } from "./domain/uiAccess.ts";
import { createSlackAdmin } from "./infrastructure/slack/adminClient.ts";
import { createGhCli } from "./infrastructure/github/ghCli.ts";
import { createDraftReply } from "./application/draftReply.ts";
import { syntheticTs } from "./domain/slackLinks.ts";
import { toolPolicyFor } from "./domain/toolPolicy.ts";
import { logSourceOrder } from "./domain/investigation.ts";
import { createDashboard } from "./infrastructure/dashboard/server.ts";
import { runForBrain } from "./application/brainRun.ts";
import { dispatchCommand, isQuietCommand } from "./application/commands.ts";
import { createCommandTickets, refusalMessage } from "./application/commandTickets.ts";
import { createActivityLog } from "./infrastructure/logger.ts";
import type { CommandLogRepo } from "./infrastructure/db/commandLogRepo.ts";
import type { LlmPort, ToolTraceSink, UsageSink } from "./application/ports.ts";
import { createToolTraceLog } from "./infrastructure/llm/toolTraceLog.ts";
import type { RespondDeps } from "./application/respond.ts";

/**
 * Where the CLI runs. Default to a neutral dir outside the bot's own source so she
 * never picks up this repo's git status / CLAUDE.md as "her job" and cannot edit
 * her own code by accident. Override with CLAUDE_CWD to point her at a project.
 */
const ensureDir = (path: string): string => {
  mkdirSync(path, { recursive: true });
  return path;
};

/** Pick the brain based on config: the local Claude Code CLI or the API. */
const buildLlm = (config: AppConfig, cwd: string, onUsage?: UsageSink, onToolTrace?: ToolTraceSink): LlmPort =>
  config.llmProvider === "claude-cli"
    ? createClaudeCliLlm({
        binPath: config.claudeBin,
        model: config.claudeModel,
        skipPermissions: config.claudeSkipPermissions,
        cwd,
        timeoutMs: config.claudeTimeoutMs,
        onUsage,
        onToolTrace,
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

  const db = openDatabase(config.databasePath);
  const users = createUserRepo(db);
  const messages = createMessageRepo(db);
  const learnings = createLearningsRepo(db);
  // Memory as a checked directory rather than a growing list of rows. Optional:
  // without an adapter.yaml at this path the bot keeps using `learnings`.
  const adapterStore = createAdapterStore(config.adapterPath);
  const adapterRevisions = createAdapterRevisionRepo(db);
  const usage = createUsageRepo(db);
  const turns = createTurnLogRepo(db);
  const watches = createWatchRepo(db);
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

  seedOwner(users, config.ownerSlackId, clock);

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
  // Drives any Mac app through the Accessibility API - no Automation needed.
  const macUiScript = join(import.meta.dir, "..", "bin", "mac-ui.js");
  // The second driver, for every app but Arc. launchd's PATH has no Homebrew,
  // so look there too; absent means it is simply not offered.
  const agentDesktop =
    Bun.which("agent-desktop", { PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` }) ?? undefined;
  // Real clicks and keystrokes for web content that ignores AXPress.
  const browserScriptsDir = join(import.meta.dir, "..", "data", "adapter", "skills", "browser-ui-test", "scripts");
  const browserScripts = ["click.js", "keys.js", "press-exact.js"].map((f) => join(browserScriptsDir, f));
  // Posts a file into a thread, so a sandboxed role can share a screenshot.
  const uploadScript = join(import.meta.dir, "..", "bin", "slack-upload.sh");
  // Reads a claude.ai artifact by opening a full session, which has the tool a
  // `-p` spawn does not.
  const artifactScript = join(import.meta.dir, "..", "bin", "artifact-read.sh");
  const restartScript = join(import.meta.dir, "..", "bin", "jarvis-restart.sh");
  const repoPath = join(import.meta.dir, "..");
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
      browserScripts,
      uploadScript,
      models: modelsForRoles(),
      protectedPaths: [repoPath],
      executerTools: (settings.get(SETTING_KEYS.executerTools) ?? "")
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
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
  const toolTrace = createToolTraceLog(join(config.logDir, "threads"));
  const llm = buildLlm(config, fullCwd, recordUsage, toolTrace);
  console.log(`[llm] ${profile().name}'s brain: ${modelLabel(config)}`);

  // Slack Web API + AI drafting, shared by the console and the power-tool commands.
  // retries: 0 so a rate-limited call fails fast instead of hanging.
  const slackWeb = new WebClient(config.slackBotToken, { retryConfig: { retries: 0 } });
  const slackAdmin = createSlackAdmin(slackWeb);
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
  let slackApp: { health: () => ConnectionHealth; inFlight: () => number } | undefined;
  const runs = createRunRegistry();
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
    macUiScript,
    agentDesktop,
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
    }: {
      channelId: string;
      threadTs: string;
      slackUserId: string;
      text: string;
      keepSession?: boolean;
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
      });
      if (result.kind !== "ignored" && result.text.trim()) {
        await slackAdmin.post(channelId, result.text, threadTs);
      }
    },
    disabledCommands,
    slack: slackAdmin,
    // `review` approves through this directly, before the brain starts.
    github: createGhCli(),
    // Long tasks driven from a thread, each holding its own CLI session.
    workflows,
    threadSessions,
    // One turn at a time per thread. Two messages a few minutes apart used to
    // run at once, doing the same work twice - two branches, two PRs - and
    // resuming the same CLI session from two processes while they did it.
    threadQueue: createThreadQueue(),
    // Handles on the turns in flight, so one can be stopped from a button or
    // `stop` instead of being waited out.
    runs,
    reviewGuard: createReviewGuard(clock),
    system,
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
    fileScript,
    grafanaGetScript,
    slackReadScript,
    artifactScript,
    restartScript,
    repoPath,
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
    commandTickets,
    commandPrefix: config.commandPrefix,
    slashCommand: config.slashCommand,
  };

  // Whether the desktop will take orders from us. Probed rather than assumed:
  // the grant is bound to the runtime's path, so upgrading it silently revokes
  // the permission and nothing says so.
  const uiAccess = createUiAccessProbe();
  // Exit, and let launchd bring us back. Deferred so the reply that asked
  // for it has landed, and held until no turn is running anywhere.
  const requestRestart = (reason: string): void => {
    activity.line(`restart requested: ${reason}`);
    restartWhenIdle({
      // An envelope still being handled is work too - a slash command or
      // a button press is not a tracked run, and exiting under it loses it.
      isIdle: () => runs.all().length === 0 && (slackApp?.inFlight() ?? 0) === 0,
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
      // Exit, and let launchd bring us back. Deferred so the reply that asked
      // for it has landed, and held until no turn is running anywhere.
      requestRestart,
      uiAccess: uiAccess.read,
      users,
      messages,
      learnings,
      kitViews,
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
          post: async (text) => void (await slackAdmin.post(ctx.channel, text, ctx.threadTs)),
          handoffMs: RUN_HANDOFF_MS,
          onLateError: (e) => activity.error("command_failed", { command: line, result: String(e) }),
        });
      },
    },
  );
  dashboard.start();

  // With a gateway, Slack traffic arrives through its inbox and the socket is
  // not ours to open - a restart here then costs a short wait, not lost messages.
  const inbox = config.slackTransport === "inbox" ? openInbox(config.inboxDatabasePath) : undefined;
  const slack = createSlackApp(
    {
      inbox: inbox
        ? createInboxReceiver({
            inbox,
            log: (l) => activity.line(`inbox: ${l}`),
            onInterrupted: (row) =>
              tidyInterrupted(slackWeb, row, interruptedNotice(row.outcome, row.retried), (l) => activity.line(`inbox: ${l}`)),
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
    { ...deps, kitViews, log: activity.line },
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

  // The thing that actually waits. It polls outside every turn and session, so
  // a thread waiting on a build is not a thread that has stopped working - and
  // a turn that said it would carry on afterwards now does.
  const watcher = createWatcher({
    watches,
    clock,
    check: createShellCheck(fullCwd),
    runTurn: deps.runTurn!,
    say: async (channel, text, thread) => void (await slackAdmin.post(channel, text, thread)),
    log: (msg) => console.error(`[watch] ${msg}`),
    onError: onDbError,
  });
  // Reminders ride the same timer: they need no model either, only a post.
  const reminderSender = createReminderSender({
    reminders,
    clock,
    post: async (channel, text, thread) => void (await slackAdmin.post(channel, text, thread)),
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
    post: async (channel, text, thread) => (await slackAdmin.post(channel, text, thread))?.ts,
    runReview: async ({ actor, channelId, threadTs, line }) => {
      const reply = async (text: string) => void (await slackAdmin.post(channelId, text, threadTs));
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
  const pendingReminders = reminders.waiting().length;
  if (pendingReminders > 0) console.log(`[remind] ${pendingReminders} reminder(s) waiting from before the restart`);
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
    post: async (channel, text, thread) => (await slackAdmin.post(channel, text, thread)) ?? undefined,
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
      if (result.text.trim()) await slackAdmin.post(channelId, result.text, threadTs);
      return result.text;
    },
    log: (msg) => console.error(`[inner-child] ${msg}`),
  });
  // A rejection on a bare timer is unhandled, and an unhandled rejection kills
  // the process - mid-turn, for whoever is talking to the bot. Never let one out.
  const tickFailed = (name: string) => (e: unknown): void => {
    console.error(`[${name}] tick failed: ${e instanceof Error ? e.message : String(e)}`);
    onDbError(e);
  };
  const watchTimer = setInterval(() => {
    void watcher.tick().catch(tickFailed("watch"));
    void reminderSender.tick().catch(tickFailed("remind"));
    void innerChild.tick().catch(tickFailed("inner-child"));
    void reviewInbox.tick().catch(tickFailed("review-inbox"));
  }, WATCH_TICK_MS);
  (watchTimer as { unref?: () => void }).unref?.();

  const shutdown = async () => {
    console.log("\nShutting down ...");
    clearInterval(watchTimer);
    dashboard.stop();
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
