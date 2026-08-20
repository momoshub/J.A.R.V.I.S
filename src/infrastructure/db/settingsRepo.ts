/**
 * Settings repository - a small key/value store for editable configuration such
 * as the bot's overridden system prompt.
 */
import type { DbClient } from "./client.ts";

/** Known setting keys. All bot-identity configuration lives here in the DB. */
export const SETTING_KEYS = {
  botName: "bot_name",
  systemPrompt: "system_prompt",
  thinkingLabel: "thinking_label",
  thinkingDoneLabel: "thinking_done_label",
  disabledCommands: "disabled_commands",
} as const;

export type SettingsRepo = {
  get: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
};

export const createSettingsRepo = (db: DbClient): SettingsRepo => {
  const getStmt = db.query<{ value: string }, [string]>(
    "SELECT value FROM settings WHERE key = ?",
  );
  const setStmt = db.query(
    `INSERT INTO settings (key, value) VALUES ($key, $value)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const removeStmt = db.query("DELETE FROM settings WHERE key = $key");

  return {
    get: (key) => getStmt.get(key)?.value,
    set: (key, value) => {
      setStmt.run({ $key: key, $value: value });
    },
    remove: (key) => {
      removeStmt.run({ $key: key });
    },
  };
};
