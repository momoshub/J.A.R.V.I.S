/**
 * Roles - the stored half of `domain/roles.ts`. One row per role but the owner.
 *
 * Read on every permission check, so the book is cached and only reloaded when a
 * write happened (here, or from another connection: `PRAGMA data_version` moves
 * for those and costs nothing to read). A save applies to the next message with
 * no restart.
 */
import type { DbClient } from "./client.ts";
import { staticBook, type Role, type RoleBook } from "../../domain/roles.ts";
import type { UserRole } from "../../domain/types.ts";

type Row = {
  name: string;
  rank: number;
  description: string;
  enabled: number;
  grants: string;
  denied_tools: string;
  seed: string | null;
};

const strings = (json: string): string[] => {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const toRole = (row: Row): Role => ({
  name: row.name,
  rank: row.rank,
  description: row.description,
  enabled: row.enabled !== 0,
  grants: strings(row.grants),
  deniedTools: strings(row.denied_tools),
  ...(row.seed ? { seed: row.seed } : {}),
});

export type RoleRepo = {
  /** The live book: stored roles plus the owner. Always current. */
  readonly book: RoleBook;
  /** Stored roles only (no owner), highest rank first. */
  stored: () => readonly Role[];
  save: (role: Role, by: string, at: number) => void;
  /** Rename a role and move everyone who holds it, in one transaction. */
  rename: (from: UserRole, to: UserRole) => void;
  remove: (name: UserRole) => void;
  /** How many people hold the role. */
  holders: (name: UserRole) => number;
};

export const createRoleRepo = (db: DbClient): RoleRepo => {
  const listStmt = db.query<Row, []>("SELECT * FROM roles ORDER BY rank DESC, name ASC");
  const versionStmt = db.query<{ data_version: number }, []>("PRAGMA data_version");
  const saveStmt = db.query(
    `INSERT INTO roles (name, rank, description, enabled, grants, denied_tools, seed, updated_by, updated_at)
     VALUES ($name, $rank, $description, $enabled, $grants, $tools, $seed, $by, $at)
     ON CONFLICT(name) DO UPDATE SET
       rank = excluded.rank,
       description = excluded.description,
       enabled = excluded.enabled,
       grants = excluded.grants,
       denied_tools = excluded.denied_tools,
       seed = excluded.seed,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  );
  const holdersStmt = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM allowed_users WHERE role = ?");

  let cached: { version: number; roles: Role[]; book: RoleBook } | undefined;
  let dirty = true;
  const load = (): { roles: Role[]; book: RoleBook } => {
    const version = versionStmt.get()?.data_version ?? 0;
    if (!cached || dirty || cached.version !== version) {
      const roles = listStmt.all().map(toRole);
      cached = { version, roles, book: staticBook(roles) };
      dirty = false;
    }
    return cached;
  };
  const book: RoleBook = {
    get: (name) => load().book.get(name),
    list: () => load().book.list(),
  };
  const write = (fn: () => void): void => {
    fn();
    dirty = true;
  };

  return {
    book,
    stored: () => load().roles,
    save: (role, by, at) =>
      write(() =>
        saveStmt.run({
          $name: role.name,
          $rank: role.rank,
          $description: role.description,
          $enabled: role.enabled ? 1 : 0,
          $grants: JSON.stringify([...new Set(role.grants)].sort()),
          $tools: JSON.stringify(role.deniedTools),
          $seed: role.seed ?? null,
          $by: by,
          $at: at,
        }),
      ),
    rename: (from, to) =>
      write(() => {
        db.exec("BEGIN");
        try {
          db.query("UPDATE roles SET name = $to WHERE name = $from").run({ $from: from, $to: to });
          db.query("UPDATE allowed_users SET role = $to WHERE role = $from").run({ $from: from, $to: to });
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      }),
    // Atomic with the holder check: a role someone was just given is not deleted.
    remove: (name) =>
      write(() => {
        db.query("DELETE FROM roles WHERE name = $name AND NOT EXISTS (SELECT 1 FROM allowed_users WHERE role = $name)").run({ $name: name });
        db.query("DELETE FROM settings WHERE key = $key AND NOT EXISTS (SELECT 1 FROM roles WHERE name = $name)").run({ $key: `model:${name}`, $name: name });
      }),
    holders: (name) => holdersStmt.get(name)?.n ?? 0,
  };
};
