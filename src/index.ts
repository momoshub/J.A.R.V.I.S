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
import { createUserRepo } from "./infrastructure/db/userRepo.ts";
import { createMessageRepo } from "./infrastructure/db/messageRepo.ts";
import { createLearningsRepo } from "./infrastructure/db/learningsRepo.ts";
import { createCommandLogRepo } from "./infrastructure/db/commandLogRepo.ts";
import { createWorkflowRepo } from "./infrastructure/db/workflowRepo.ts";
import { createAccessRequestRepo } from "./infrastructure/db/accessRequestRepo.ts";
import { createCommandApprovalRepo } from "./infrastructure/db/commandApprovalRepo.ts";
import { createSettingsRepo, SETTING_KEYS } from "./infrastructure/db/settingsRepo.ts";
import { loadBotProfile } from "./application/botProfile.ts";
import { seedOwner } from "./infrastructure/db/seed.ts";
import { createAnthropicLlm } from "./infrastructure/llm/anthropic.ts";
import { createClaudeCliLlm } from "./infrastructure/llm/claudeCli.ts";
import { WebClient } from "@slack/web-api";
import { createSlackApp } from "./infrastructure/slack/app.ts";
import { createSlackAdmin } from "./infrastructure/slack/adminClient.ts";
import { createGhCli } from "./infrastructure/github/ghCli.ts";
import { createDraftReply } from "./application/draftReply.ts";
import { toolPolicyFor } from "./domain/toolPolicy.ts";
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

const main = async () => {
  const config = loadConfig();

  const db = openDatabase(config.databasePath);
  const users = createUserRepo(db);
  const messages = createMessageRepo(db);
  const learnings = createLearningsRepo(db);
  const settings = createSettingsRepo(db);
  // Activity log to the logs/ folder: every command (and message) is recorded,
  // failed commands additionally land in errors.log.
  const activity = createActivityLog(config.logDir);
  const workflows = createWorkflowRepo(db);
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
  const toolPolicy = (role: Parameters<typeof toolPolicyFor>[0]) =>
    toolPolicyFor(role, {
      fullCwd,
      sandboxCwd,
      reactScript,
      runScript,
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
    // A stranger is put to the owner for a ✅ / ❌ rather than refused outright.
    accessRequests,
    // A pal out of allowance has their command parked for approval.
    commandApprovals,
    // Per-person allowances live here, set with the `limit` command.
    settings,
    reactScript,
    draft,
    toolPolicy,
    // The dashboard API is loopback-only, so the brain can save a learning the
    // same way the dashboard does - offered to admins/owner conversations only.
    learnUrl: `http://127.0.0.1:${config.dashboardPort}/api/learnings`,
    runUrl: `http://127.0.0.1:${config.dashboardPort}/api/commands/run`,
    runScript,
    commandTickets,
    commandPrefix: config.commandPrefix,
    slashCommand: config.slashCommand,
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
        return dispatchCommand(deps, user, ctx.channel, line, {
          prefix: config.commandPrefix,
          slash: config.slashCommand,
          threadTs: ctx.threadTs,
          reply: (text: string) => slackAdmin.post(ctx.channel, text, ctx.threadTs),
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
