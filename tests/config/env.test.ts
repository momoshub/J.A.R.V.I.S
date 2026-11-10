import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config/env.ts";

const base = {
  SLACK_BOT_TOKEN: "xoxb-x",
  SLACK_APP_TOKEN: "xapp-x",
  ANTHROPIC_API_KEY: "sk-x",
  OWNER_SLACK_ID: "U0OWNER0001",
};

describe("loadConfig", () => {
  test("the bot's own Orca terminal defaults to ~/Workspaces, blank included, and can be switched off", () => {
    expect(loadConfig(base).orcaTerminalWorktree).toMatch(/^path:.*\/Workspaces$/);
    expect(loadConfig({ ...base, ORCA_TERMINAL_WORKTREE: "path:/srv/work" }).orcaTerminalWorktree).toBe("path:/srv/work");
    expect(loadConfig({ ...base, ORCA_TERMINAL_WORKTREE: "off" }).orcaTerminalWorktree).toBeUndefined();
    // a blank line in .env is the default, not off
    expect(loadConfig({ ...base, ORCA_TERMINAL_WORKTREE: " " }).orcaTerminalWorktree).toMatch(/^path:.*\/Workspaces$/);
  });

  test("a turn started while a restart waits gets a 2 minute budget by default", () => {
    expect(loadConfig(base).restartTurnBudgetMs).toBe(120_000);
    expect(loadConfig({ ...base, RESTART_TURN_BUDGET_MS: "90000" }).restartTurnBudgetMs).toBe(90_000);
    expect(() => loadConfig({ ...base, RESTART_TURN_BUDGET_MS: "0" })).toThrow();
  });

  test("the offline alarm channel is an id, never a name", () => {
    expect(loadConfig(base).offlineAlarmChannel).toBeUndefined();
    expect(loadConfig({ ...base, OFFLINE_ALARM_CHANNEL: "" }).offlineAlarmChannel).toBeUndefined();
    expect(loadConfig({ ...base, OFFLINE_ALARM_CHANNEL: "C0TEST00002" }).offlineAlarmChannel).toBe("C0TEST00002");
    expect(loadConfig({ ...base, OFFLINE_ALARM_CHANNEL: " " }).offlineAlarmChannel).toBeUndefined();
    expect(loadConfig({ ...base, OFFLINE_ALARM_CHANNEL: "C0TEST00002 " }).offlineAlarmChannel).toBe("C0TEST00002");
    expect(() => loadConfig({ ...base, OFFLINE_ALARM_CHANNEL: "#jarvis_status" })).toThrow(/channel id/);
  });

  test("owner and database-server lists are comma lists, empty by default", () => {
    const c = loadConfig(base);
    expect(c.reviewExtendedOwners).toEqual([]);
    expect(c.dbMcpServers).toEqual([]);
    expect(c.executerDbMcpServers).toEqual([]);
    const d = loadConfig({
      ...base,
      REVIEW_EXTENDED_OWNERS: " acme, other ,,",
      DB_MCP_SERVERS: "pg-prod, ch-ro",
      EXECUTER_DB_MCP_SERVERS: "ch-ro",
    });
    expect(d.reviewExtendedOwners).toEqual(["acme", "other"]);
    expect(d.dbMcpServers).toEqual(["pg-prod", "ch-ro"]);
    expect(d.executerDbMcpServers).toEqual(["ch-ro"]);
  });

  test("applies defaults", () => {
    const c = loadConfig(base);
    expect(c.dashboardPort).toBe(2001);
    expect(c.anthropicModel).toBe("claude-opus-4-8");
    expect(c.databasePath).toBe("data/bot.db");
    expect(c.commandPrefix).toBe("//bot");
    expect(c.slashCommand).toBe("/bot");
  });

  test("database paths may live outside the checkout (~ expands) and name where to migrate from", () => {
    const c = loadConfig(base);
    expect(c.databaseMigrateFrom).toBeUndefined();
    expect(c.tokenDatabaseMigrateFrom).toBeUndefined();
    const o = loadConfig({
      ...base,
      DATABASE_PATH: "~/.jarvis/data/jarvis.db",
      DATABASE_MIGRATE_FROM: "data/jarvis.db",
      TOKEN_DATABASE_PATH: "/srv/jarvis/tokens.db",
      TOKEN_DATABASE_MIGRATE_FROM: " data/tokens.db ",
    });
    expect(o.databasePath).toMatch(/^\/.*\/\.jarvis\/data\/jarvis\.db$/);
    expect(o.databasePath.startsWith("~")).toBe(false);
    expect(o.databaseMigrateFrom).toBe("data/jarvis.db");
    expect(o.tokenDatabasePath).toBe("/srv/jarvis/tokens.db");
    expect(o.tokenDatabaseMigrateFrom).toBe("data/tokens.db");
    // a blank line in .env is unset, not a path
    expect(loadConfig({ ...base, DATABASE_MIGRATE_FROM: " " }).databaseMigrateFrom).toBeUndefined();
  });

  test("GitHub App defaults keep every secret in files outside the repo", () => {
    const g = loadConfig(base).githubApp;
    expect(g.port).toBe(2003);
    expect(g.slug).toBe("jarvis-at-acme");
    expect(g.label).toBe("jarvis");
    expect(g.allowedOwners).toEqual(["acme"]);
    expect(g.privateKeyPath).toMatch(/\.config\/jarvis\/github-app\/private-key\.pem$/);
    expect(g.webhookSecretPath).toMatch(/\.config\/jarvis\/github-app\/webhook-secret$/);
    expect(g.webhookSecret).toBeUndefined();
    expect(g.appId).toBeUndefined();
    const o = loadConfig({ ...base, GITHUB_APP_ALLOWED_OWNERS: "acme, kai-at-acme", GITHUB_APP_PORT: "2010" }).githubApp;
    expect(o.allowedOwners).toEqual(["acme", "kai-at-acme"]);
    expect(o.port).toBe(2010);
  });

  test("throws a readable error when required vars are missing", () => {
    expect(() => loadConfig({})).toThrow(/Invalid configuration/);
  });

  test("coerces the dashboard port", () => {
    const c = loadConfig({ ...base, DASHBOARD_PORT: "3000" });
    expect(c.dashboardPort).toBe(3000);
  });

  test("splits self PRs across two GitHub accounts only when both are set", () => {
    expect(loadConfig(base).selfPrAccounts).toBeUndefined();
    expect(loadConfig({ ...base, SELF_PR_AUTHOR: "writer" }).selfPrAccounts).toBeUndefined();
    expect(loadConfig({ ...base, SELF_PR_AUTHOR: "writer", SELF_PR_REVIEWER: " " }).selfPrAccounts).toBeUndefined();
    // one login twice is no second pair of eyes
    expect(loadConfig({ ...base, SELF_PR_AUTHOR: "writer", SELF_PR_REVIEWER: "Writer" }).selfPrAccounts).toBeUndefined();
    expect(loadConfig({ ...base, SELF_PR_AUTHOR: " writer ", SELF_PR_REVIEWER: "checker" }).selfPrAccounts).toEqual({
      author: "writer",
      reviewer: "checker",
    });
  });
});
