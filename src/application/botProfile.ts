/**
 * Bot profile - the instance's identity, sourced from the database so the
 * codebase stays generic. Values fall back to configured defaults (env), then to
 * neutral built-ins, so a fresh clone runs as a plain "Assistant" until an admin
 * customises it from the dashboard.
 */
import { DEFAULT_BOT_NAME } from "../domain/personality.ts";
import { SETTING_KEYS, type SettingsRepo } from "../infrastructure/db/settingsRepo.ts";

export type BotProfile = {
  /** Display name and self-reference. */
  readonly name: string;
  /** Custom base persona, or undefined to use the built-in default. */
  readonly persona?: string;
  /** Label for the "thinking" step shown on long messages. */
  readonly thinkingLabel: string;
};

export type BotProfileDefaults = {
  readonly name?: string;
  readonly thinkingLabel: string;
};

/** Read the current profile from settings, applying defaults. */
export const loadBotProfile = (
  settings: SettingsRepo,
  defaults: BotProfileDefaults,
): BotProfile => ({
  name: settings.get(SETTING_KEYS.botName)?.trim() || defaults.name?.trim() || DEFAULT_BOT_NAME,
  persona: settings.get(SETTING_KEYS.systemPrompt) || undefined,
  thinkingLabel: settings.get(SETTING_KEYS.thinkingLabel)?.trim() || defaults.thinkingLabel,
});
