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
  /** Notion database new tickets are created in. */
  ticketTracker: "ticket_tracker",
  /** The team's "how to raise a ticket" SOP page. */
  ticketSop: "ticket_sop",
  /** The page describing which pod owns what. */
  ticketPods: "ticket_pods",
  /** Repos the bot may open a fix PR in, comma separated. */
  ticketRepos: "ticket_repos",
  /** Ceiling on child agents one review may spawn. */
  reviewAgents: "review_agents",
  /** "off" turns one-session-per-thread back into a cold call per turn. */
  threadSessions: "thread_sessions",
  /** Lowest role that may run `read`, which borrows the host human's access. */
  readMinRole: "read_min_role",
  /** Notion page or database new pages are created under. */
  notionParent: "notion_parent",
  /** Slack ids turned away for good: answered, never raised as a request. */
  snubbed: "snubbed",
  /** What those people are told. Empty falls back to a neutral refusal. */
  snubReply: "snub_reply",
  /** Who may publish a page into Notion with the host's identity. */
  noteMinRole: "note_min_role",
  /** Answer replies under a thread the bot itself started ("off" to disable). */
  followOwnThreads: "follow_own_threads",
  /** Channel the inner child announces and runs its self-fixes in. Empty = off. */
  innerChildChannel: "inner_child_channel",
  /** "off" pauses the inner child without forgetting its channel. */
  innerChild: "inner_child",
  /** Where its last triage stopped (ms), so a restart neither re-reads nor skips. */
  innerChildCursor: "inner_child_cursor",
  /** Channel GitHub review requests of the bot's account are posted and reviewed in. Empty = off. */
  reviewInboxChannel: "review_inbox_channel",
  /** ISO time of the last review request handled. */
  reviewInboxCursor: "review_inbox_cursor",
} as const;

/** Model override for one role, e.g. `model:pal`. Empty means "use the default". */
export const modelKey = (role: string): string => `model:${role}`;

/** Review policy for one repository, e.g. `review_policy:owner/repo`. */
export const reviewPolicyKey = (repo: string): string => `review_policy:${repo.toLowerCase()}`;
/** Same, keyed by PR author login (already normalised by `authorRefOf`). */
export const authorReviewPolicyKey = (login: string): string => `review_policy_author:${login.toLowerCase()}`;

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
