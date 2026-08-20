/**
 * Composition root.
 *
 * The only place that knows about every layer at once: load config, open the
 * database, build the adapters, wire the use-case dependencies, and start both
 * the Slack listener and the dashboard. Everything below this file is decoupled
 * and independently testable.
 */
import { loadConfig } from "./config/env.ts";
import { openDatabase } from "./infrastructure/db/client.ts";
import { createUserRepo } from "./infrastructure/db/userRepo.ts";
import { createMessageRepo } from "./infrastructure/db/messageRepo.ts";
import { seedOwner } from "./infrastructure/db/seed.ts";
import { createAnthropicLlm } from "./infrastructure/llm/anthropic.ts";
import { createSlackApp } from "./infrastructure/slack/app.ts";
import { createDashboard } from "./infrastructure/dashboard/server.ts";
import type { RespondDeps } from "./application/respond.ts";

const main = async () => {
  const config = loadConfig();

  const db = openDatabase(config.databasePath);
  const users = createUserRepo(db);
  const messages = createMessageRepo(db);
  const clock = () => Date.now();

  seedOwner(users, config.ownerSlackId, clock);

  const llm = createAnthropicLlm({
    apiKey: config.anthropicApiKey,
    model: config.anthropicModel,
  });

  const deps: RespondDeps = {
    users,
    messages,
    llm,
    clock,
    ownerSlackId: config.ownerSlackId,
  };

  const dashboard = createDashboard(
    {
      port: config.dashboardPort,
      token: config.dashboardToken,
      ownerSlackId: config.ownerSlackId,
      model: config.anthropicModel,
    },
    { users, messages, clock },
  );
  dashboard.start();

  const slack = createSlackApp(
    { botToken: config.slackBotToken, appToken: config.slackAppToken },
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
