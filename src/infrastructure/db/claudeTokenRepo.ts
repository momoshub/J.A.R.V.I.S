/**
 * Per-user Claude Code tokens, kept in their own database.
 *
 * Its own file, not the main database: that one carries the allowlist and the
 * bot's identity and gets edited by hand, and credentials have no business
 * sharing a table space with it.
 *
 * Values are encrypted with AES-256-GCM under a key kept beside the database in
 * its own 0600 file. The database is committed like the main one; the key is
 * not, so what lands in git is ciphertext rather than a set of live credentials,
 * and a copy taken from anywhere but the host opens nothing. It is not
 * protection against someone who already has the host.
 */
import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ClaudeTokenPort } from "../../application/claudeTokens.ts";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * The key beside the database, minted on first use. Returned raw so the caller
 * holds it in memory only; it is never logged and never leaves this process.
 */
export const loadOrCreateKey = (path: string): Buffer => {
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    if (key.length === KEY_BYTES) return key;
    throw new Error(`token key at ${path} is not a ${KEY_BYTES}-byte base64 key`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(path, key.toString("base64"), { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
};

/** `iv.ciphertext.tag`, each base64. Self-describing, so nothing else is stored. */
const seal = (plain: string, key: Buffer): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, body, cipher.getAuthTag()].map((b) => b.toString("base64")).join(".");
};

/**
 * Undefined rather than a throw when a row will not open: a key that was rotated
 * or a row that was tampered with should read as "no token on file", which sends
 * the user back through the normal ask, not as a crash mid-review.
 */
const unseal = (sealed: string, key: Buffer): string | undefined => {
  const [iv, body, tag] = sealed.split(".");
  if (!iv || !body || !tag) return undefined;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
};

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

  const get = (slackId: string): string | undefined => {
    const row = getStmt.get(slackId);
    return row ? unseal(row.sealed, key) : undefined;
  };

  return {
    get,
    has: (slackId) => get(slackId) !== undefined,
    set: (slackId, token) => {
      setStmt.run({ $id: slackId, $sealed: seal(token.trim(), key), $at: now() });
    },
    remove: (slackId) => {
      removeStmt.run({ $id: slackId });
    },
    count: () => countStmt.get()?.n ?? 0,
  };
};
