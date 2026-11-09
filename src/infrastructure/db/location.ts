/**
 * Where a database file lives, and moving it there once.
 *
 * The live SQLite files used to sit in `data/`, inside the git checkout, so a
 * `git stash`, `checkout`, `reset` or `rebase` could swap the file under the
 * open handle. They now belong outside the repo (`DATABASE_PATH`,
 * `TOKEN_DATABASE_PATH`), and an instance moves over without a manual copy:
 * `adoptDatabase` fills a missing destination from the old file on first boot.
 *
 * Nothing here ever deletes or overwrites a database that holds tables.
 */
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
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
  /** `to` was missing (or an empty shell) and has been filled from `from`. */
  | "migrated"
  /** `to` already holds tables: left exactly as it is. */
  | "present"
  /** No `from` configured (or it names the same file) and `to` is missing: the bot starts a fresh database. */
  | "nothing-to-adopt";

export type AdoptOptions = {
  /** File mode for the new database (0o600 for credentials). */
  mode?: number;
  /** Receives the resolved absolute `to` / `from` and the outcome, on every call. */
  log?: (line: string) => void;
  /** What a relative `from` resolves against; the checkout by default, never the cwd. */
  root?: string;
};

/** The repo checkout: where a relative `DATABASE_MIGRATE_FROM` (`data/jarvis.db`) has always pointed. */
const CHECKOUT_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** Does the database file hold at least one table? Throws if it is not a database at all. */
const hasTables = (path: string): boolean => {
  const db = new Database(path);
  try {
    const row = db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get();
    return (row?.n ?? 0) > 0;
  } finally {
    db.close();
  }
};

/** A file that is absent, 0 bytes, or a database without tables carries nothing worth keeping. */
const isEmptyShell = (path: string): boolean => {
  if (!existsSync(path)) return true;
  if (statSync(path).size === 0 && !(existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 0)) return true;
  return !hasTables(path);
};

/**
 * One-time move of a database to a new path: when `to` is absent or an empty
 * shell (0 bytes, no tables) and `from` holds a database, `to` becomes a
 * snapshot of `from`. `from` is only read, and is left in place. A `to` with
 * tables is never touched.
 *
 * Fails closed: with `from` configured and `to` unusable, a `from` that is
 * missing or empty THROWS, because falling through would let the caller create
 * a brand-new empty database where the real one was meant to be adopted (a typo,
 * a relative path under another cwd), and every later boot would then see it as
 * "present". A relative `from` resolves against `root` (the checkout), not the cwd. With `log`, the
 * resolved absolute paths and the outcome are reported on every call.
 */
export const adoptDatabase = (
  to: string,
  from: string | undefined,
  { mode, log, root = CHECKOUT_ROOT }: AdoptOptions = {},
): AdoptResult => {
  if (to === ":memory:") return "nothing-to-adopt";
  const absTo = resolve(to);
  const absFrom = from && resolveDbPath(from, root) !== absTo ? resolveDbPath(from, root) : undefined;
  const done = (result: AdoptResult): AdoptResult => {
    log?.(`[db] to=${absTo} from=${absFrom ?? "(none)"} -> ${result}`);
    return result;
  };
  const toEmpty = isEmptyShell(absTo);
  if (!toEmpty) return done("present");
  if (!absFrom) return done("nothing-to-adopt");
  if (!existsSync(absFrom) || isEmptyShell(absFrom)) {
    log?.(`[db] to=${absTo} from=${absFrom} -> refusing to start`);
    throw new Error(
      `database migration source ${absFrom} is missing or holds no tables, and the destination ${absTo} ` +
        `${existsSync(absTo) ? "is empty" : "does not exist"}: refusing to start on an empty database. ` +
        "Fix DATABASE_MIGRATE_FROM (a relative path resolves against the checkout), or unset it to start fresh.",
    );
  }
  if (existsSync(absTo)) for (const f of [absTo, `${absTo}-wal`, `${absTo}-shm`]) rmSync(f, { force: true });
  snapshotDatabase(absFrom, absTo, mode);
  return done("migrated");
};
