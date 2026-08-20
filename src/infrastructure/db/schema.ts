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

  // Roles are validated in the domain, not the DB, so the set can evolve freely.
  db.exec(`
    CREATE TABLE IF NOT EXISTS allowed_users (
      slack_id     TEXT PRIMARY KEY,
      role         TEXT NOT NULL,
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

  migrateRoles(db);
};

/**
 * Migration v2: older databases created `allowed_users` with a CHECK constraint
 * limiting roles to owner/admin/member. Rebuild the table without the CHECK and
 * map the legacy `member` role to `pal`.
 */
const migrateRoles = (db: Database): void => {
  const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get() ?? {
    user_version: 0,
  };
  if (user_version >= 2) return;

  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE allowed_users_v2 (
        slack_id     TEXT PRIMARY KEY,
        role         TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        added_by     TEXT NOT NULL DEFAULT 'system',
        created_at   INTEGER NOT NULL
      );
    `);
    db.exec(`
      INSERT INTO allowed_users_v2 (slack_id, role, display_name, added_by, created_at)
      SELECT slack_id, CASE role WHEN 'member' THEN 'pal' ELSE role END, display_name, added_by, created_at
      FROM allowed_users;
    `);
    db.exec("DROP TABLE allowed_users;");
    db.exec("ALTER TABLE allowed_users_v2 RENAME TO allowed_users;");
    db.exec("PRAGMA user_version = 2;");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
};
