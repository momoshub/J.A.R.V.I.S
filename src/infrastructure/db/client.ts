/**
 * SQLite client factory.
 *
 * Wraps `bun:sqlite` so the rest of the app depends on a small, testable seam.
 * Pass ":memory:" for tests, a file path for the real thing.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./schema.ts";

export type DbClient = Database;

/**
 * Open (or create) the database at `path`, ensuring the parent directory exists
 * and the schema is migrated. Use ":memory:" for an ephemeral test database.
 */
export const openDatabase = (path: string): DbClient => {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  migrate(db);
  return db;
};
