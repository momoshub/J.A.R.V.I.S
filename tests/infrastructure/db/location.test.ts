import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptDatabase, resolveDbPath, snapshotDatabase } from "../../../src/infrastructure/db/location.ts";
import { expandHome } from "../../../src/domain/dbPath.ts";
import { openDatabase } from "../../../src/infrastructure/db/client.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-loc-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A WAL-mode database with a row that only the WAL holds (writer still open). */
const liveDb = (path: string) => {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA wal_autocheckpoint = 0");
  db.run("CREATE TABLE t (v TEXT)");
  db.run("INSERT INTO t VALUES ('in-the-wal')");
  return db;
};
const rows = (path: string) => {
  const db = new Database(path, { readonly: true });
  const out = db.query<{ v: string }, []>("SELECT v FROM t").all().map((r) => r.v);
  db.close();
  return out;
};

describe("path resolution", () => {
  test("~ means the home directory, nothing else is touched", () => {
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("~/x/y.db", "/h")).toBe("/h/x/y.db");
    expect(expandHome("data/bot.db", "/h")).toBe("data/bot.db");
    expect(expandHome("/abs/bot.db", "/h")).toBe("/abs/bot.db");
    expect(expandHome("~other/bot.db", "/h")).toBe("~other/bot.db");
  });

  test("a relative path resolves against the working directory, an absolute one is kept", () => {
    expect(resolveDbPath("data/bot.db", "/repo", "/h")).toBe("/repo/data/bot.db");
    expect(resolveDbPath("~/.jarvis/bot.db", "/repo", "/h")).toBe("/h/.jarvis/bot.db");
    expect(resolveDbPath("/srv/bot.db", "/repo", "/h")).toBe("/srv/bot.db");
  });
});

describe("snapshotDatabase", () => {
  test("copies what a live WAL database holds and refuses to overwrite", () => {
    const src = join(dir, "src.db");
    const live = liveDb(src);
    const dest = join(dir, "out", "dest.db");
    snapshotDatabase(src, dest);
    expect(rows(dest)).toEqual(["in-the-wal"]);
    expect(readdirSync(join(dir, "out"))).toEqual(["dest.db"]);
    expect(() => snapshotDatabase(src, dest)).toThrow(/refusing to overwrite/);
    live.close();
  });

  test("a WAL database nobody has open (clean shutdown) is copied without touching the original", () => {
    const src = join(dir, "idle.db");
    liveDb(src).close();
    // what a clean shutdown leaves: the database alone, no sidecars
    rmSync(`${src}-shm`, { force: true });
    rmSync(`${src}-wal`, { force: true });
    const before = readFileSync(src);
    const dest = join(dir, "out.db");
    snapshotDatabase(src, dest);
    expect(rows(dest)).toEqual(["in-the-wal"]);
    expect(readFileSync(src).equals(before)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["idle.db", "out.db"]);
  });

  test("a WAL left behind by a crash (no -shm) is included", () => {
    const live = join(dir, "live.db");
    const db = liveDb(live);
    const crashed = join(dir, "crashed");
    mkdirSync(crashed);
    copyFileSync(live, join(crashed, "x.db"));
    copyFileSync(`${live}-wal`, join(crashed, "x.db-wal"));
    db.close();
    const dest = join(dir, "out.db");
    snapshotDatabase(join(crashed, "x.db"), dest);
    expect(rows(dest)).toEqual(["in-the-wal"]);
    expect(readdirSync(crashed).filter((f) => !f.endsWith("-shm")).sort()).toEqual(["x.db", "x.db-wal"]);
  });

  test("a failed snapshot leaves no half-written destination", () => {
    const bad = join(dir, "not-a-db.db");
    Bun.write(bad, "this is not sqlite");
    const dest = join(dir, "dest.db");
    expect(() => snapshotDatabase(bad, dest)).toThrow();
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes("tmp"))).toEqual([]);
  });
});

describe("adoptDatabase (the one-time migration)", () => {
  test("fills a missing destination from the old file and leaves the old file alone", () => {
    const from = join(dir, "old", "jarvis.db");
    Bun.spawnSync(["mkdir", "-p", join(dir, "old")]);
    const live = liveDb(from);
    const before = statSync(from).mtimeMs;
    const to = join(dir, "new", "deep", "jarvis.db");
    expect(adoptDatabase(to, from)).toBe("migrated");
    expect(rows(to)).toEqual(["in-the-wal"]);
    expect(existsSync(from)).toBe(true);
    expect(statSync(from).mtimeMs).toBe(before);
    live.close();
  });

  test("never overwrites a destination that exists, so a second boot changes nothing", () => {
    const from = join(dir, "old.db");
    const to = join(dir, "new.db");
    liveDb(from).close();
    expect(adoptDatabase(to, from)).toBe("migrated");
    const db = new Database(to);
    db.run("INSERT INTO t VALUES ('written-after')");
    db.close();
    expect(adoptDatabase(to, from)).toBe("present");
    expect(rows(to)).toEqual(["in-the-wal", "written-after"]);
  });

  test("does nothing without a source, with a missing source, or when both are the same file", () => {
    const to = join(dir, "new.db");
    expect(adoptDatabase(to, undefined)).toBe("nothing-to-adopt");
    expect(adoptDatabase(to, join(dir, "absent.db"))).toBe("nothing-to-adopt");
    const same = join(dir, "same.db");
    liveDb(same).close();
    expect(adoptDatabase(same, same)).toBe("present");
    expect(adoptDatabase(join(dir, "x", "..", "same2.db"), join(dir, "same2.db"))).toBe("nothing-to-adopt");
    expect(existsSync(to)).toBe(false);
    expect(adoptDatabase(":memory:", same)).toBe("nothing-to-adopt");
  });

  test("a credential database keeps owner-only permissions", () => {
    const from = join(dir, "tokens-old.db");
    const to = join(dir, "tokens.db");
    liveDb(from).close();
    expect(adoptDatabase(to, from, 0o600)).toBe("migrated");
    expect(statSync(to).mode & 0o777).toBe(0o600);
  });

  test("the migrated file opens as the bot's database, schema and all", () => {
    const from = join(dir, "bot-old.db");
    const to = join(dir, "bot.db");
    openDatabase(from).close();
    expect(adoptDatabase(to, from)).toBe("migrated");
    const db = openDatabase(to);
    expect(db.query("SELECT count(*) AS n FROM sqlite_master WHERE name = 'allowed_users'").get()).toEqual({ n: 1 });
    db.close();
  });
});
