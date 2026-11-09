/**
 * Where a database file lives, and moving it there once.
 *
 * The live SQLite files used to sit in `data/`, inside the git checkout, so a
 * `git stash`, `checkout`, `reset` or `rebase` could swap the file under the
 * open handle. They now belong outside the repo (`DATABASE_PATH`,
 * `TOKEN_DATABASE_PATH`), and an instance moves over without a manual copy:
 * `adoptDatabase` fills a missing destination from the old file on first boot.
 *
 * Nothing here ever deletes or overwrites a database.
 */
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { expandHome } from "../../domain/dbPath.ts";

/** The absolute form of a configured path, relative ones against `cwd`. */
export const resolveDbPath = (path: string, cwd: string = process.cwd(), home: string = homedir()): string => {
  const expanded = expandHome(path, home);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
};

/**
 * Write a consistent, standalone copy of the database at `src` to `dest`.
 *
 * `VACUUM INTO` reads through SQLite, so the copy includes whatever is still in
 * the WAL and is safe while the bot is writing - a plain file copy is neither.
 * The copy is built beside `dest` and renamed into place, so `dest` is either
 * absent or whole. Refuses to replace an existing `dest`. `src` is never modified (a read-only open of a WAL file may leave an empty `-shm` beside it).
 */
export const snapshotDatabase = (src: string, dest: string, mode?: number): void => {
  if (existsSync(dest)) throw new Error(`refusing to overwrite ${dest}`);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  const scratch = `${dest}.src-${process.pid}`;
  rmSync(tmp, { force: true });
  rmSync(scratch, { recursive: true, force: true });
  try {
    try {
      vacuumInto(src, tmp, true);
    } catch (e) {
      if ((e as { code?: unknown }).code !== "SQLITE_CANTOPEN") throw e;
      // A WAL database nobody has open (a clean shutdown removes its -shm) cannot
      // be opened read-only. No writer holds it then, so a private copy of the
      // file and any leftover WAL is consistent, and opening THAT leaves the
      // original untouched.
      rmSync(tmp, { force: true });
      mkdirSync(scratch, { recursive: true });
      const copy = join(scratch, "db");
      copyFileSync(src, copy);
      for (const side of ["-wal"]) if (existsSync(src + side)) copyFileSync(src + side, copy + side);
      vacuumInto(copy, tmp, false);
    }
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

const vacuumInto = (src: string, out: string, readonly: boolean): void => {
  const db = readonly ? new Database(src, { readonly: true }) : new Database(src);
  try {
    db.run(`VACUUM INTO '${out.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
};

export type AdoptResult =
  /** `to` was missing and has been filled from `from`. */
  | "migrated"
  /** `to` already exists: left exactly as it is. */
  | "present"
  /** No `from` configured, or both name the same file, or `from` is not there. */
  | "nothing-to-adopt";

/**
 * One-time move of a database to a new path: when `to` does not exist and
 * `from` does, `to` becomes a snapshot of `from`. `from` is only read, and is
 * left in place.
 */
export const adoptDatabase = (to: string, from: string | undefined, mode?: number): AdoptResult => {
  if (to === ":memory:") return "nothing-to-adopt";
  if (existsSync(to)) return "present";
  if (!from || resolve(from) === resolve(to) || !existsSync(from)) return "nothing-to-adopt";
  snapshotDatabase(from, to, mode);
  return "migrated";
};
