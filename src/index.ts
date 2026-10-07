/**
 * Composition root.
 *
 * The only place that knows about every layer at once: load config, open the
 * database, build the adapters, wire the use-case dependencies, and start both
 * the Slack listener and the dashboard. Everything below this file is decoupled
 * and independently testable.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, modelLabel, type AppConfig } from "./config/env.ts";
import { openDatabase } from "./infrastructure/db/client.ts";
import { createThreadSessionRepo } from "./infrastructure/db/threadSessionRepo.ts";
import { createThreadQueue } from "./application/threadQueue.ts";
import { createRunRegistry } from "./application/runRegistry.ts";
import { createTotpRepo } from "./infrastructure/db/totpRepo.ts";
import {
  createClaudeTokenRepo,
  loadOrCreateKey,
  openTokenDatabase,
} from "./infrastructure/db/claudeTokenRepo.ts";
import { createUserRepo } from "./infrastructure/db/userRepo.ts";
import { createMessageRepo } from "./infrastructure/db/messageRepo.ts";
import { createLearningsRepo } from "./infrastructure/db/learningsRepo.ts";
import { createCommandLogRepo } from "./infrastructure/db/commandLogRepo.ts";
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
import type { ConnectionHealth } from "./domain/connectionHealth.ts";
import { createSlackAdmin } from "./infrastructure/slack/adminClient.ts";
import { createGhCli } from "./infrastructure/github/ghCli.ts";
import { createDraftReply } from "./application/draftReply.ts";
import { toolPolicyFor } from "./domain/toolPolicy.ts";
import { logSourceOrder } from "./domain/investigation.ts";
import { createDashboard } from "./infrastructure/dashboard/server.ts";
import { dispatchCommand } from "./application/commands.ts";
import { createCommandTickets } from "./application/commandTickets.ts";
import { createActivityLog } from "./infrastructure/logger.ts";
import type { CommandLogRepo } from "./infrastructure/db/commandLogRepo.ts";
import type { LlmPort } from "./application/ports.ts";
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
const buildLlm = (config: AppConfig, cwd: string): LlmPort =>
  config.llmProvider === "claude-cli"
    ? createClaudeCliLlm({
        binPath: config.claudeBin,
        model: config.claudeModel,
        skipPermissions: config.claudeSkipPermissions,
        cwd,
        timeoutMs: config.claudeTimeoutMs,
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
  const commandTickets = createCommandTickets(() => Date.now());
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
      models: modelsForRoles(),
      executerTools: (settings.get(SETTING_KEYS.executerTools) ?? "")
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    });

  const llm = buildLlm(config, fullCwd);
  console.log(`[llm] ${profile().name}'s brain: ${modelLabel(config)}`);

  // Slack Web API + AI drafting, shared by the console and the power-tool commands.
  // retries: 0 so a rate-limited call fails fast instead of hanging.
  const slackAdmin = createSlackAdmin(new WebClient(config.slackBotToken, { retryConfig: { retries: 0 } }));
  const promptContext = () => ({
    botName: profile().name,
    base: settings.get(SETTING_KEYS.systemPrompt),
    learnings: learnings.list().map((l) => l.content),
  });
  const draft = createDraftReply({ llm, promptContext });

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
    botInfo: () => ({ botName: profile().name, model: modelLabel(config) }),
    commandLog,
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
    runs: createRunRegistry(),
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
    runScript,
    commandTickets,
    commandPrefix: config.commandPrefix,
    slashCommand: config.slashCommand,
  };

  // Filled in once the Slack app exists, so /health can report the socket from
  // the moment it does and never trips over the order things are built in.
  let slackApp: { health: () => ConnectionHealth } | undefined;
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
      users,
      messages,
      learnings,
      settings,
      clock,
      profile,
      // Console: manage the bot's live Slack messages, with AI-drafted replies.
      slack: slackAdmin,
      draft,
      commandLog,
      // Lets the brain run a real command when a chat request is really one.
      // The actor's own role decides what is allowed - nothing is elevated by
      // going through here.
      runCommand: async ({ ticket, line }) => {
        const ctx = commandTickets.redeem(ticket);
        if (!ctx) throw new Error("that ticket is not valid any more");
        const user = users.get(ctx.actor);
        if (!user) throw new Error("whoever asked is not on the access list");
        const run = dispatchCommand(deps, user, ctx.channel, line, {
          prefix: config.commandPrefix,
          slash: config.slashCommand,
          threadTs: ctx.threadTs,
          reply: (text: string) => slackAdmin.post(ctx.channel, text, ctx.threadTs),
        });

        // Do not make the caller wait. The chat turn that triggers a command is
        // itself a CLI process on a chat-length timeout, and a `review` or
        // `ticket` runs for minutes - blocking here kills that turn with a
        // SIGTERM and posts "I hit an error" over a command that is working
        // perfectly. The command reports into the thread itself, so there is
        // nothing for the caller to relay anyway.
        const settled = await Promise.race([
          run.then((text) => ({ done: true as const, text })),
          new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), RUN_HANDOFF_MS)),
        ]);
        if (settled.done) return settled.text;
        run
          .then((text) => {
            if (text.trim()) return slackAdmin.post(ctx.channel, text, ctx.threadTs);
          })
          .catch((e) => activity.error("command_failed", { command: line, result: String(e) }));
        return "started - it reports into the thread as it goes";
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
