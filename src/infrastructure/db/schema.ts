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
      created_at    INTEGER NOT NULL,
      -- Slack ts of the source message, when there is one (see migration v3).
      slack_ts      TEXT NOT NULL DEFAULT '',
      -- Thread the turn belongs to; memory is scoped to it (see migration v4).
      thread_ts     TEXT NOT NULL DEFAULT ''
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
  migrateSlackTs(db);
  migrateThreadTs(db);
  migrateWorkflows(db);
  migrateAccessRequests(db);
  migrateCommandApprovals(db);
  migrateAccessNotices(db);
};

/**
 * Migration v8: an access request can be put to several people.
 *
 * Admins decide these as well as the owner, and a DM only the owner can see is
 * not something an admin can react to - so each notice is its own row and a
 * reaction on any of them resolves the request.
 */
const migrateAccessNotices = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_request_notices (
      request_id INTEGER NOT NULL,
      channel    TEXT NOT NULL,
      ts         TEXT NOT NULL,
      PRIMARY KEY (channel, ts)
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_access_notices_request ON access_request_notices (request_id);");
  db.exec("PRAGMA user_version = 8;");
};

/**
 * Migration v7: commands held for approval.
 *
 * A rate-limited role does not simply get refused - the command is parked here
 * and the owner is asked. `notice_ts` is the message carrying the buttons, so a
 * click finds its way back to what it was approving.
 */
const migrateCommandApprovals = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS command_approvals (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      slack_user_id  TEXT NOT NULL,
      display_name   TEXT NOT NULL DEFAULT '',
      channel_id     TEXT NOT NULL,
      thread_ts      TEXT NOT NULL DEFAULT '',
      line           TEXT NOT NULL,
      notice_channel TEXT NOT NULL DEFAULT '',
      notice_ts      TEXT NOT NULL DEFAULT '',
      status         TEXT NOT NULL DEFAULT 'pending',
      decided_by     TEXT NOT NULL DEFAULT '',
      created_at     INTEGER NOT NULL,
      decided_at     INTEGER
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_command_approvals_status ON command_approvals (status, id DESC);");
  db.exec("PRAGMA user_version = 7;");
};

/**
 * Migration v6: pending access requests.
 *
 * Someone the bot does not know is not turned away any more - the owner is
 * asked. `notice_ts` is the DM the owner reacts on, which is how a reaction
 * finds its way back to the person who is waiting.
 */
const migrateAccessRequests = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_requests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slack_user_id TEXT NOT NULL,
      display_name  TEXT NOT NULL DEFAULT '',
      channel_id    TEXT NOT NULL,
      thread_ts     TEXT NOT NULL DEFAULT '',
      asked         TEXT NOT NULL DEFAULT '',
      notice_channel TEXT NOT NULL DEFAULT '',
      notice_ts     TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    INTEGER NOT NULL,
      decided_at    INTEGER
    );
  `);
  // One open request per person; decided ones stay for the record.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_access_requests_pending
      ON access_requests (slack_user_id) WHERE status = 'pending';
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_access_requests_notice
      ON access_requests (notice_channel, notice_ts);
  `);
  db.exec("PRAGMA user_version = 6;");
};

/**
 * Migration v5: long-running workflow sessions.
 *
 * One row per thread that is driving a durable CLI session. `session_id` is the
 * id the CLI was started with, so the session survives a bot restart: the next
 * message in that thread resumes it.
 */
const migrateWorkflows = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id  TEXT NOT NULL,
      thread_ts   TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      task        TEXT NOT NULL,
      started_by  TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active',
      turns       INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);
  // At most one live workflow per thread; stopped ones stay for the record.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_active
      ON workflows (channel_id, thread_ts) WHERE status = 'active';
  `);
  db.exec("PRAGMA user_version = 5;");
};

/**
 * Migration v4: remember which thread a turn belongs to.
 *
 * Memory used to be keyed by channel alone, so every thread in a channel (and
 * every separate DM exchange, since the bot always replies in a thread) shared
 * one window and bled into the others. Rows written before this have an empty
 * thread and simply fall out of scope.
 */
const migrateThreadTs = (db: Database): void => {
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(messages)").all();
  if (!columns.some((c) => c.name === "thread_ts")) {
    db.exec("ALTER TABLE messages ADD COLUMN thread_ts TEXT NOT NULL DEFAULT '';");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_thread_time
      ON messages (channel_id, thread_ts, id);
  `);
  db.exec("PRAGMA user_version = 4;");
};

/**
 * Migration v3: remember which Slack message a stored turn came from, so the bot
 * can point at earlier messages in the conversation (reacting to them, say).
 * Rows written before this have an empty ts and are simply not addressable.
 */
const migrateSlackTs = (db: Database): void => {
  // Keyed off the column itself, not user_version: a fresh database already gets
  // it from CREATE TABLE, an existing one needs the ALTER.
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(messages)").all();
  if (!columns.some((c) => c.name === "slack_ts")) {
    db.exec("ALTER TABLE messages ADD COLUMN slack_ts TEXT NOT NULL DEFAULT '';");
  }
  db.exec("PRAGMA user_version = 3;");
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
