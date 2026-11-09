import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "..", "..", "bin", "db-backup.ts");

let dir: string;
let backups: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-backup-"));
  backups = join(dir, "backups");
  for (const name of ["jarvis", "tokens"]) {
    const db = new Database(join(dir, `${name}.db`), { create: true });
    db.run("CREATE TABLE t (v TEXT)");
    db.run(`INSERT INTO t VALUES ('${name}')`);
    db.close();
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...a: string[]) =>
  Bun.spawnSync(["git", "-C", cwd, ...a], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });

const run = (...args: string[]) =>
  Bun.spawnSync(["bun", script, ...args], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      SLACK_BOT_TOKEN: "xoxb-x",
      SLACK_APP_TOKEN: "xapp-x",
      ANTHROPIC_API_KEY: "sk-x",
      OWNER_SLACK_ID: "U0OWNER0001",
      DATABASE_PATH: join(dir, "jarvis.db"),
      TOKEN_DATABASE_PATH: join(dir, "tokens.db"),
      TOKEN_KEY_PATH: join(dir, "tokens.key"),
      DATABASE_BACKUP_DIR: backups,
    },
  });

describe("bin/db-backup.ts", () => {
  test("writes a snapshot of each database, the token copy owner-only", () => {
    const res = run();
    expect(res.exitCode).toBe(0);
    const files = readdirSync(backups).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^jarvis-\d{8}T\d{6}Z\.db$/);
    expect(files[1]).toMatch(/^tokens-\d{8}T\d{6}Z\.db$/);
    expect(statSync(join(backups, files[1] as string)).mode & 0o777).toBe(0o600);
    const copy = new Database(join(backups, files[0] as string), { readonly: true });
    expect(copy.query("SELECT v FROM t").all()).toEqual([{ v: "jarvis" }]);
    copy.close();
  });

  test("--keep N prunes the oldest beyond N per database", () => {
    mkdirSync(backups);
    for (const name of ["jarvis", "tokens"]) {
      for (const day of ["01", "02", "03", "04"]) writeFileSync(join(backups, `${name}-202001${day}T000000Z.db`), "old");
    }
    expect(run("--keep", "2").exitCode).toBe(0);
    const files = readdirSync(backups).sort();
    // the new snapshot plus the newest old one, for each database
    expect(files.filter((f) => f.startsWith("jarvis-"))).toHaveLength(2);
    expect(files.filter((f) => f.startsWith("tokens-"))).toHaveLength(2);
    expect(files).toContain("jarvis-20200104T000000Z.db");
    expect(files).not.toContain("jarvis-20200103T000000Z.db");
    expect(files).not.toContain("tokens-20200101T000000Z.db");
  });

  test("a --keep that is not a whole number of 1 or more is refused", () => {
    expect(run("--keep", "0").exitCode).toBe(2);
    expect(run("--keep", "x").exitCode).toBe(2);
  });

  test("--commit stages only the backup folder, not the repo it is run from", () => {
    git(dir, "init", "-q");
    writeFileSync(join(dir, "unrelated.txt"), "dirty");
    mkdirSync(backups);
    git(backups, "init", "-q");
    expect(run("--commit").exitCode).toBe(0);
    const committed = git(backups, "show", "--name-only", "--format=", "HEAD").stdout.toString().trim().split("\n").sort();
    expect(committed).toHaveLength(2);
    expect(committed.every((f) => /^(jarvis|tokens)-\d{8}T\d{6}Z\.db$/.test(f))).toBe(true);
    // the outer repo saw nothing: nothing staged, the file still untracked
    expect(git(dir, "diff", "--cached", "--name-only").stdout.toString().trim()).toBe("");
    expect(git(dir, "status", "--porcelain").stdout.toString()).toContain("?? unrelated.txt");
  });

  test("without --commit nothing is staged or committed", () => {
    mkdirSync(backups);
    git(backups, "init", "-q");
    expect(run().exitCode).toBe(0);
    expect(git(backups, "log", "--oneline").exitCode).not.toBe(0);
    expect(git(backups, "diff", "--cached", "--name-only").stdout.toString().trim()).toBe("");
  });
});
