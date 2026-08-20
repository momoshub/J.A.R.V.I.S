/**
 * Database schema and migration.
 *
 * A single idempotent migration keeps things simple: it is safe to run on every
 * boot. When the schema grows, add further `CREATE`/`ALTER` statements guarded
 * so re-running stays a no-op.
 */
import type { Database } from "bun:sqlite";

export const migrate = (db: Database): void => {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS allowed_users (
      slack_id     TEXT PRIMARY KEY,
      role         TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
      display_name TEXT NOT NULL DEFAULT '',
      added_by     TEXT NOT NULL DEFAULT 'system',
      created_at   INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id    TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content       TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_channel_time
      ON messages (channel_id, id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS learnings (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      content    TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'system',
      created_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS command_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slack_user_id TEXT NOT NULL,
      command       TEXT NOT NULL,
      args          TEXT NOT NULL DEFAULT '',
      channel_id    TEXT NOT NULL DEFAULT '',
      ok            INTEGER NOT NULL DEFAULT 1,
      result        TEXT NOT NULL DEFAULT '',
      created_at    INTEGER NOT NULL
    );
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_command_log_time ON command_log (id DESC);");
};
