/**
 * Per-user Claude Code tokens, kept in their own database.
 *
 * Its own file, not the main database: that one carries the allowlist and the
 * bot's identity and gets edited by hand, and credentials have no business
 * sharing a table space with it.
 *
 * Encryption lives in `secretBox.ts`, shared with the other secrets in this
 * file - see there for what the envelope is and what it does not protect.
 */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadOrCreateKey, seal, unseal } from "./secretBox.ts";
import type { ClaudeTokenPort } from "../../application/claudeTokens.ts";

// Re-exported so the composition root keeps opening the database and its key
// through one import, as it always has.
export { loadOrCreateKey };

/** Open (or create) the token database. `:memory:` for tests. */
export const openTokenDatabase = (path: string): Database => {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.run(`CREATE TABLE IF NOT EXISTS claude_tokens (
    slack_id   TEXT PRIMARY KEY,
    sealed     TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  // Who has already been asked. Its own table: it is not a credential, and it
  // outlives the absence of one - the whole point is not to ask twice.
  db.run(`CREATE TABLE IF NOT EXISTS token_asks (
    slack_id TEXT PRIMARY KEY,
    asked_at INTEGER NOT NULL
  )`);
  // Shared TOTP seeds, keyed by the label they are asked for by. Same file as
  // the tokens: both are credentials, both want the same key and the same 0600.
  db.run(`CREATE TABLE IF NOT EXISTS totp_secrets (
    label      TEXT PRIMARY KEY,
    sealed     TEXT NOT NULL,
    account    TEXT,
    added_by   TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  if (path !== ":memory:") chmodSync(path, 0o600);
  return db;
};

export const createClaudeTokenRepo = (
  db: Database,
  key: Buffer,
  now: () => number = () => Date.now(),
): ClaudeTokenPort => {
  const getStmt = db.query<{ sealed: string }, [string]>(
    "SELECT sealed FROM claude_tokens WHERE slack_id = ?",
  );
  const setStmt = db.query(
    `INSERT INTO claude_tokens (slack_id, sealed, updated_at) VALUES ($id, $sealed, $at)
     ON CONFLICT(slack_id) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at`,
  );
  const removeStmt = db.query("DELETE FROM claude_tokens WHERE slack_id = $id");
  const countStmt = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM claude_tokens");
  // Ids and timestamps only. Nothing here returns a sealed value, so no caller
  // can accidentally render someone's credential into a channel.
  const listStmt = db.query<{ slack_id: string; updated_at: number }, []>(
    "SELECT slack_id, updated_at FROM claude_tokens ORDER BY updated_at DESC",
  );
  const askedStmt = db.query<{ slack_id: string }, [string]>(
    "SELECT slack_id FROM token_asks WHERE slack_id = ?",
  );
  const markStmt = db.query(
    `INSERT INTO token_asks (slack_id, asked_at) VALUES ($id, $at)
     ON CONFLICT(slack_id) DO UPDATE SET asked_at = excluded.asked_at`,
  );
  const clearAskStmt = db.query("DELETE FROM token_asks WHERE slack_id = $id");

  const get = (slackId: string): string | undefined => {
    const row = getStmt.get(slackId);
    return row ? unseal(row.sealed, key) : undefined;
  };

  return {
    get,
    has: (slackId) => get(slackId) !== undefined,
    set: (slackId, token) => {
      setStmt.run({ $id: slackId, $sealed: seal(token.trim(), key), $at: now() });
      // They answered, so the ask is spent. Removing a token later earns a fresh
      // one rather than a reminder about a box that is no longer relevant.
      clearAskStmt.run({ $id: slackId });
    },
    remove: (slackId) => {
      removeStmt.run({ $id: slackId });
      clearAskStmt.run({ $id: slackId });
    },
    count: () => countStmt.get()?.n ?? 0,
    list: () => listStmt.all().map((r) => ({ slackId: r.slack_id, updatedAt: r.updated_at })),
    asked: (slackId) => askedStmt.get(slackId) !== null,
    markAsked: (slackId) => {
      markStmt.run({ $id: slackId, $at: now() });
    },
  };
};
