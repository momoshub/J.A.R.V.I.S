import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config/env.ts";

const base = {
  SLACK_BOT_TOKEN: "xoxb-x",
  SLACK_APP_TOKEN: "xapp-x",
  ANTHROPIC_API_KEY: "sk-x",
  OWNER_SLACK_ID: "U0OWNER0001",
};

describe("loadConfig", () => {
  test("applies defaults", () => {
    const c = loadConfig(base);
    expect(c.dashboardPort).toBe(2001);
    expect(c.anthropicModel).toBe("claude-opus-4-8");
    expect(c.databasePath).toBe("data/bot.db");
    expect(c.commandPrefix).toBe("//bot");
    expect(c.slashCommand).toBe("/bot");
  });

  test("throws a readable error when required vars are missing", () => {
    expect(() => loadConfig({})).toThrow(/Invalid configuration/);
  });

  test("coerces the dashboard port", () => {
    const c = loadConfig({ ...base, DASHBOARD_PORT: "3000" });
    expect(c.dashboardPort).toBe(3000);
  });
});
