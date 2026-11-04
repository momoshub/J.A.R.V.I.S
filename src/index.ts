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
import { RESTART_DELAY_MS } from "./domain/selfUpdate.ts";
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
import { respond } from "./application/respond.ts";
import type { ConnectionHealth } from "./domain/connectionHealth.ts";
import { createUiAccessProbe } from "./infrastructure/system/uiAccessProbe.ts";
import { describeUiAccess, needsAttention } from "./domain/uiAccess.ts";
import { createSlackAdmin } from "./infrastructure/slack/adminClient.ts";
import { createGhCli } from "./infrastructure/github/ghCli.ts";
import { createDraftReply } from "./application/draftReply.ts";
import { toolPolicyFor } from "./domain/toolPolicy.ts";
import { logSourceOrder } from "./domain/investigation.ts";
import { createDashboard } from "./infrastructure/dashboard/server.ts";
import { runForBrain } from "./application/brainRun.ts";
import { dispatchCommand, isQuietCommand } from "./application/commands.ts";
import { createCommandTickets, refusalMessage } from "./application/commandTickets.ts";
import { createActivityLog } from "./infrastructure/logger.ts";
import type { CommandLogRepo } from "./infrastructure/db/commandLogRepo.ts";
import type { LlmPort, UsageSink } from "./application/ports.ts";
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
const buildLlm = (config: AppConfig, cwd: string, onUsage?: UsageSink): LlmPort =>
  config.llmProvider === "claude-cli"
    ? createClaudeCliLlm({
        binPath: config.claudeBin,
        model: config.claudeModel,
        skipPermissions: config.claudeSkipPermissions,
        cwd,
        timeoutMs: config.claudeTimeoutMs,
        onUsage,
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
      models: modelsForRoles(),
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

  const llm = buildLlm(config, fullCwd, recordUsage);
  console.log(`[llm] ${profile().name}'s brain: ${modelLabel(config)}`);

  // Slack Web API + AI drafting, shared by the console and the power-tool commands.
  // retries: 0 so a rate-limited call fails fast instead of hanging.
  const slackAdmin = createSlackAdmin(new WebClient(config.slackBotToken, { retryConfig: { retries: 0 } }));
  const promptContext = () => ({
    botName: profile().name,
    base: settings.get(SETTING_KEYS.systemPrompt),
    learnings: learnings.list().map((l) => l.content),
    adapter: adapterReader.read(),
  });
  const draft = createDraftReply({ llm, promptContext });

  // Filled in once the Slack app exists, so /health and `sys` can report the
  // socket from the moment it does and never trip over the order things are
  // built in.
  let slackApp: { health: () => ConnectionHealth } | undefined;
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
    // Re-run a dead turn, or nudge a quiet thread, from `mindful`. It goes
    // through the ordinary respond path on purpose: same queue, same session,
    // same role checks - a retry that took a shortcut would not be a retry of
    // the thing that failed.
    runTurn: async ({
      channelId,
      threadTs,
      slackUserId,
      text,
    }: {
      channelId: string;
      threadTs: string;
      slackUserId: string;
      text: string;
    }) => {
      const result = await respond(deps, {
        channelId,
        slackUserId,
        text,
        threadTs,
        messageTs: threadTs,
        viaSlash: false,
        following: false,
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
      // for it has landed before the process goes.
      requestRestart: (reason: string) => {
        activity.line(`restart requested: ${reason}`);
        setTimeout(() => {
          console.log("Restarting on request ...");
          process.exit(0);
        }, RESTART_DELAY_MS).unref?.();
      },
      uiAccess: uiAccess.read,
      users,
      messages,
      learnings,
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

  const slack = createSlackApp(
    {
      botToken: config.slackBotToken,
      appToken: config.slackAppToken,
      streamUpdates: config.slackStreamUpdates,
      botName: profile().name,
      thinkingLabel: () => profile().thinkingLabel,
      thinkingDoneLabel: () => profile().thinkingDoneLabel,
      commandPrefix: config.commandPrefix,
      slashCommand: config.slashCommand,
    },
    { ...deps, log: activity.line },
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

  const shutdown = async () => {
    console.log("\nShutting down ...");
    dashboard.stop();
    await slack.stop();
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
