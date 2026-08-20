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
import { createSettingsRepo, SETTING_KEYS } from "./infrastructure/db/settingsRepo.ts";
import { seedOwner } from "./infrastructure/db/seed.ts";
import { createAnthropicLlm } from "./infrastructure/llm/anthropic.ts";
import { createClaudeCliLlm } from "./infrastructure/llm/claudeCli.ts";
import { createSlackApp } from "./infrastructure/slack/app.ts";
import { createDashboard } from "./infrastructure/dashboard/server.ts";
import type { LlmPort } from "./application/ports.ts";
import type { RespondDeps } from "./application/respond.ts";

/**
 * Where the CLI runs. Default to a neutral dir outside E.V.'s own source so she
 * never picks up this repo's git status / CLAUDE.md as "her job" and cannot edit
 * her own code by accident. Override with CLAUDE_CWD to point her at a project.
 */
const resolveClaudeCwd = (config: AppConfig): string => {
  const cwd = config.claudeCwd ?? join(tmpdir(), "ev-agent-workspace");
  mkdirSync(cwd, { recursive: true });
  return cwd;
};

/** Pick the brain based on config: the local Claude Code CLI or the API. */
const buildLlm = (config: AppConfig): LlmPort =>
  config.llmProvider === "claude-cli"
    ? createClaudeCliLlm({
        binPath: config.claudeBin,
        model: config.claudeModel,
        skipPermissions: config.claudeSkipPermissions,
        cwd: resolveClaudeCwd(config),
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
  const clock = () => Date.now();

  seedOwner(users, config.ownerSlackId, clock);

  const llm = buildLlm(config);
  console.log(`[llm] E.V.'s brain: ${modelLabel(config)}`);

  const deps: RespondDeps = {
    users,
    messages,
    llm,
    clock,
    ownerSlackId: config.ownerSlackId,
    // Live personality + learnings, editable from the dashboard.
    promptContext: () => ({
      base: settings.get(SETTING_KEYS.systemPrompt),
      learnings: learnings.list().map((l) => l.content),
    }),
  };

  const dashboard = createDashboard(
    {
      port: config.dashboardPort,
      token: config.dashboardToken,
      ownerSlackId: config.ownerSlackId,
      model: modelLabel(config),
    },
    { users, messages, learnings, settings, clock },
  );
  dashboard.start();

  const slack = createSlackApp(
    {
      botToken: config.slackBotToken,
      appToken: config.slackAppToken,
      streamUpdates: config.slackStreamUpdates,
    },
    deps,
  );
  await slack.start();

  const shutdown = async () => {
    console.log("\nShutting down E.V. ...");
    dashboard.stop();
    await slack.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

main().catch((err) => {
  console.error("E.V. failed to start:", err);
  process.exit(1);
});
