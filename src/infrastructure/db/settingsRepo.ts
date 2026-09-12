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
  executerTools: "executer_tools",
  /** Ordered csv of observability backends, e.g. `grafana,datadog`. */
  logSources: "log_sources",
} as const;

/** Model override for one role, e.g. `model:pal`. Empty means "use the default". */
export const modelKey = (role: string): string => `model:${role}`;

/** Review policy for one repository, e.g. `review_policy:owner/repo`. */
export const reviewPolicyKey = (repo: string): string => `review_policy:${repo.toLowerCase()}`;

export type SettingsRepo = {
  get: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
  /** Every stored setting, for listing a family of keys. */
  list: () => { key: string; value: string }[];
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
  const listStmt = db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings ORDER BY key");

  return {
    get: (key) => getStmt.get(key)?.value,
    set: (key, value) => {
      setStmt.run({ $key: key, $value: value });
    },
    remove: (key) => {
      removeStmt.run({ $key: key });
    },
    list: () => listStmt.all(),
  };
};
