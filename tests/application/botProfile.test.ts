import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createSettingsRepo, SETTING_KEYS } from "../../src/infrastructure/db/settingsRepo.ts";
import { loadBotProfile } from "../../src/application/botProfile.ts";

const settings = () => createSettingsRepo(openDatabase(":memory:"));
const defaults = { name: "EnvName", thinkingLabel: "env-thinking", thinkingDoneLabel: "env-done" };

describe("loadBotProfile precedence", () => {
  test("DB setting wins over the env default", () => {
    const s = settings();
    s.set(SETTING_KEYS.botName, "DbName");
    expect(loadBotProfile(s, defaults).name).toBe("DbName");
  });

  test("env default is used when the setting is unset", () => {
    expect(loadBotProfile(settings(), defaults).name).toBe("EnvName");
  });

  test("built-in default when both setting and env are absent", () => {
    expect(loadBotProfile(settings(), { thinkingLabel: "x", thinkingDoneLabel: "y" }).name).toBe("Assistant");
  });

  test("whitespace-only settings fall through", () => {
    const s = settings();
    s.set(SETTING_KEYS.botName, "   ");
    s.set(SETTING_KEYS.thinkingLabel, "  ");
    const p = loadBotProfile(s, defaults);
    expect(p.name).toBe("EnvName");
    expect(p.thinkingLabel).toBe("env-thinking");
  });

  test("persona is undefined unless a system_prompt is set", () => {
    const s = settings();
    expect(loadBotProfile(s, defaults).persona).toBeUndefined();
    s.set(SETTING_KEYS.systemPrompt, "custom persona");
    expect(loadBotProfile(s, defaults).persona).toBe("custom persona");
  });

  test("thinking labels resolve from settings then defaults", () => {
    const s = settings();
    s.set(SETTING_KEYS.thinkingDoneLabel, "🐦‍🔥");
    const p = loadBotProfile(s, defaults);
    expect(p.thinkingDoneLabel).toBe("🐦‍🔥");
    expect(p.thinkingLabel).toBe("env-thinking");
  });
});
