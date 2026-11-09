#!/usr/bin/env bun
//
// Snapshot the live databases into a backup folder.
//
//   db-backup.ts [--keep N] [--commit]
//
// The live databases sit outside the git checkout (DATABASE_PATH,
// TOKEN_DATABASE_PATH), so git no longer holds a copy of them. This is the copy:
// a consistent `VACUUM INTO` snapshot of each one, safe while the bot is
// running, as `<name>-<UTC stamp>.db` in DATABASE_BACKUP_DIR (default
// `~/.jarvis/backups`). `--keep N` (default 14) prunes the oldest beyond N per
// database. `--commit` also commits the folder when it is a git repository of its
// own - point DATABASE_BACKUP_DIR at a private clone to keep the old "database in
// git" property without the live file ever being in a checkout someone stashes.
// The token database is ciphertext; its key (TOKEN_KEY_PATH) is not backed up.
// Run it from cron or launchd (README, "Backups").
import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig } from "../src/config/env.ts";
import { expandHome } from "../src/domain/dbPath.ts";
import { snapshotDatabase } from "../src/infrastructure/db/location.ts";

const args = process.argv.slice(2);
const keepAt = args.indexOf("--keep");
const keep = keepAt >= 0 ? Number(args[keepAt + 1]) : 14;
if (!Number.isInteger(keep) || keep < 1) {
  console.error("--keep needs a whole number of 1 or more");
  process.exit(2);
}

const config = loadConfig();
const dir = expandHome((process.env.DATABASE_BACKUP_DIR ?? "").trim() || "~/.jarvis/backups");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

const sources = [config.databasePath, config.tokenDatabasePath].filter((p) => existsSync(p));
if (sources.length === 0) {
  console.error("no database found to back up");
  process.exit(1);
}

for (const src of sources) {
  const name = basename(src, ".db");
  const isToken = src === config.tokenDatabasePath;
  const dest = join(dir, `${name}-${stamp}.db`);
  snapshotDatabase(src, dest, isToken ? 0o600 : undefined);
  console.log(`backed up ${src} -> ${dest}`);
  const mine = readdirSync(dir)
    .filter((f) => f.startsWith(`${name}-`) && f.endsWith(".db"))
    .sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - keep))) rmSync(join(dir, old));
}

if (args.includes("--commit") && existsSync(join(dir, ".git"))) {
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", dir, ...a]);
  git("add", "-A");
  const res = git("commit", "-m", `db backup ${stamp}`);
  console.log(res.exitCode === 0 ? "committed" : "nothing to commit");
}
