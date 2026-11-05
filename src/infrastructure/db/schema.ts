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
  migrateThreadSessions(db);
  migrateSessionPromptHash(db);
  migrateAdapterRevisions(db);
  migrateLlmUsage(db);
  migrateTurnLog(db);
  migrateWatches(db);
  migrateFollowedThreads(db);
  migrateReminders(db);
};

/**
 * Migration v16: reminders people asked for.
 *
 * A time and a line to post, nothing else - no predicate, no turn. `due_at`
 * is indexed for the same reason `watches.next_at` is: the timer asks "what is
 * due" on every tick for as long as the bot is up.
 */
const migrateReminders = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id  TEXT NOT NULL,
      thread_ts   TEXT NOT NULL DEFAULT '',
      created_by  TEXT NOT NULL,
      targets     TEXT NOT NULL,
      text        TEXT NOT NULL,
      due_at      INTEGER NOT NULL,
      state       TEXT NOT NULL DEFAULT 'waiting',
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (state, due_at);");
  const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get() ?? {
    user_version: 0,
  };
  if (user_version < 16) db.exec("PRAGMA user_version = 16;");
};

/**
 * Migration v15: threads it was ASKED to follow.
 *
 * Following was ownership and nothing else - a reply under a thread the bot
 * opened is addressed to it, anything else needs a tag. That is the right
 * default for a room it is a guest in, and it is not what somebody means by
 * "auto reply to this thread": they are pointing at a conversation started by
 * a person, and asking the bot to keep up with it without being tagged on
 * every line. Asked for that twice, it answered "I can't auto-reply to every
 * message in a thread", which was true and useless.
 *
 * One row per thread, added deliberately and removed the same way. There is
 * no expiry: a thread that goes quiet costs nothing, and a follow that
 * silently lapsed would be worse than one that has to be turned off.
 */
const migrateFollowedThreads = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS followed_threads (
      channel_id TEXT NOT NULL,
      thread_ts  TEXT NOT NULL,
      added_by   TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (channel_id, thread_ts)
    );
  `);
  const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get() ?? {
    user_version: 0,
  };
  if (user_version < 15) db.exec("PRAGMA user_version = 15;");
};

/**
 * Migration v14: things the bot is waiting for.
 *
 * A turn cannot wait - it ends - so anything promised "once the build is done"
 * never happened, and the thread sat on "waiting on it before promoting" until
 * a person came back. The row outlives the turn: a predicate polled on a timer
 * outside any session, and a follow-up turn when it finally passes.
 *
 * `next_at` is indexed because the poller asks one question on every tick -
 * what is due - and asks it for as long as the bot is up.
 */
const migrateWatches = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS watches (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id    TEXT NOT NULL,
      thread_ts     TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      note          TEXT NOT NULL,
      check_cmd     TEXT NOT NULL DEFAULT '',
      every_ms      INTEGER NOT NULL,
      deadline_at   INTEGER NOT NULL,
      next_at       INTEGER NOT NULL,
      state         TEXT NOT NULL DEFAULT 'waiting',
      attempts      INTEGER NOT NULL DEFAULT 0,
      errors        INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT NOT NULL DEFAULT '',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_watches_due ON watches (state, next_at);");
  const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get() ?? {
    user_version: 0,
  };
  if (user_version < 14) db.exec("PRAGMA user_version = 14;");
};

/**
 * Migration v13: how each turn ENDED.
 *
 * Nothing recorded this. A command's outcome went to `command_log`, a run's
 * tokens now go to `llm_usage`, and the live registry knows what is in flight -
 * but a chat turn that failed left only a line on stderr and an apology in a
 * thread, so "what went wrong this afternoon, and where" could not be answered
 * at all without reading the log by hand.
 *
 * The request text is kept (truncated) rather than looked up in `messages`,
 * because the one thing worth doing with a failed turn is running it again,
 * and a retry that depends on a table a `forget` can empty is a retry that
 * stops working exactly when someone needs it.
 */
const migrateTurnLog = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        TEXT NOT NULL DEFAULT '',
      channel_id    TEXT NOT NULL,
      thread_ts     TEXT NOT NULL DEFAULT '',
      slack_user_id TEXT NOT NULL DEFAULT '',
      kind          TEXT NOT NULL DEFAULT 'chat',
      request       TEXT NOT NULL DEFAULT '',
      outcome       TEXT NOT NULL DEFAULT 'ok',
      error         TEXT NOT NULL DEFAULT '',
      started_at    INTEGER NOT NULL,
      ended_at      INTEGER NOT NULL
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_turn_log_time ON turn_log (ended_at);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_turn_log_thread ON turn_log (channel_id, thread_ts);");
  const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get() ?? {
    user_version: 0,
  };
  if (user_version < 13) db.exec("PRAGMA user_version = 13;");
};

/**
 * Migration v12: what each run of the model consumed.
 *
 * Every turn spawns a CLI process, a long review runs for ten minutes, and
 * nothing anywhere recorded what any of it came to - not per person, not per
 * command, not in total. Asked what it was still bad at, the bot put this
 * first: "no dashboard says what the tokens cost, per person or per command".
 *
 * `cost_usd` is the CLI's own list-price figure. On a subscription credential
 * nobody is invoiced it, so it measures consumption rather than money, and
 * `payer` records whose credential carried it: the bot's own, the caller's
 * token (a review), or the host login (a ticket).
 */
const migrateLlmUsage = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_usage (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slack_user_id TEXT NOT NULL DEFAULT '',
      kind          TEXT NOT NULL DEFAULT 'chat',
      channel_id    TEXT NOT NULL DEFAULT '',
      model         TEXT NOT NULL DEFAULT '',
      payer         TEXT NOT NULL DEFAULT 'bot',
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read    INTEGER NOT NULL DEFAULT 0,
      cache_write   INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL NOT NULL DEFAULT 0,
      duration_ms   INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_llm_usage_time ON llm_usage (created_at);");
  const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get() ?? {
    user_version: 0,
  };
  if (user_version < 12) db.exec("PRAGMA user_version = 12;");
};

/**
 * Migration v11: adapter revisions.
 *
 * Memory moved out of the `learnings` table and into a checked directory, so
 * every change to it is now a commit that can be read back and undone. The
 * table stores a whole snapshot rather than a diff: an adapter is a few dozen
 * small text files, and a revert that cannot itself fail is worth far more
 * than the bytes it saves.
 */
const migrateAdapterRevisions = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS adapter_revisions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      reason     TEXT NOT NULL DEFAULT '',
      files      TEXT NOT NULL
    );
  `);
  const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get() ?? {
    user_version: 0,
  };
  if (user_version < 11) db.exec("PRAGMA user_version = 11;");
};

/**
 * Migration v10: a session records the rules it was opened under.
 *
 * The system prompt is sent on every turn, but a resumed session also carries
 * everything it has already said, and that wins. A rule change therefore never
 * reached a thread that was already running - verifiably correct prompt, old
 * behaviour, three times over. A session whose rules have changed is dropped
 * and reopened instead.
 */
const migrateSessionPromptHash = (db: Database): void => {
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(thread_sessions)").all();
  if (cols.some((c) => c.name === "prompt_hash")) return;
  db.exec("ALTER TABLE thread_sessions ADD COLUMN prompt_hash TEXT NOT NULL DEFAULT ''");
  db.exec("PRAGMA user_version = 10;");
};

/**
 * Migration v9: one CLI session per Slack thread.
 *
 * A thread is one conversation, so it gets one session that the model keeps its
 * context and its files in, instead of a cold start replayed from the bot's own
 * transcript every turn.
 *
 * Keyed by tier as well as thread, and not by accident: full-access and
 * sandboxed roles run the CLI in different working directories, and the CLI
 * stores a session under the directory it ran in - so a sandboxed turn could
 * not resume a full-access session even if we wanted it to, and wanting it to
 * would hand a pal whatever an admin's session had read.
 */
const migrateThreadSessions = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_sessions (
      channel_id TEXT NOT NULL,
      thread_ts  TEXT NOT NULL,
      tier       TEXT NOT NULL,
      session_id TEXT NOT NULL,
      last_ts    TEXT NOT NULL DEFAULT '',
      turns      INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      used_at    INTEGER NOT NULL,
      PRIMARY KEY (channel_id, thread_ts, tier)
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_thread_sessions_used ON thread_sessions (used_at DESC);");
  db.exec("PRAGMA user_version = 9;");
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
