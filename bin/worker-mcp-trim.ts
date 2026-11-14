#!/usr/bin/env bun
//
// Keeps the host's chosen MCP servers out of the Orca worker about to start in a
// folder (see src/domain/workerMcp.ts for why this is a file and not a flag).
//
//   worker-mcp-trim.ts            the worker home: BOT_WORKER_HOME (WORKER_HOME_DIR)
//   worker-mcp-trim.ts <folder>   one checkout (fanout's own worktrees)
//
// Adds the servers named in BOT_WORKER_MCP_DENY (the bot's WORKER_MCP_DENY, comma
// separated) to `deniedMcpServers` in <folder>/.claude/settings.local.json and keeps
// the file out of git. Run it BEFORE the worker launches: a session reads the file
// once, at start. Safe to repeat. With the variable empty it trims nothing, so a
// prompt can call it unconditionally. A settings file it cannot read as JSON is left
// alone (exit 1).
//
// With no argument the folder is the worker home, the one place every Orca worker
// starts: it is created, and registered with Orca as a plain folder when `orca repo
// list` does not know it (`--worktree path:` only takes folders Orca knows), so the
// trim never touches a folder a person works in.
//
// Exit: 0 done or nothing to do, 1 could not write or register, 2 usage.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { logAndIgnore } from "../src/application/ignoredError.ts";
import {
  mergeDeniedServers,
  orcaRepoPaths,
  parseDenyList,
  WORKER_HOME_ENV,
  WORKER_MCP_DENY_ENV,
  WORKER_SETTINGS_PATH,
} from "../src/domain/workerMcp.ts";

const git = (dir: string, ...args: string[]): { ok: boolean; out: string } => {
  const proc = Bun.spawnSync({ cmd: ["git", "-C", dir, ...args], stdout: "pipe", stderr: "pipe" });
  return { ok: proc.exitCode === 0, out: new TextDecoder().decode(proc.stdout).trim() };
};

/**
 * The file is host config, never something a worker should commit with `git add -A`.
 * The exclude list is the repository's own and shared by its worktrees, so it is one
 * line per folder; a folder that is not in a repository has nothing to exclude.
 */
const keepOutOfGit = (dir: string): void => {
  if (git(dir, "check-ignore", "-q", WORKER_SETTINGS_PATH).ok) return;
  const where = git(dir, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
  if (!where.ok || !where.out) return;
  // The folder may be a subfolder of the repository, and the exclude list is anchored at its root.
  const prefix = git(dir, "rev-parse", "--show-prefix");
  if (!prefix.ok) return;
  const line = `/${prefix.out}${WORKER_SETTINGS_PATH}`;
  try {
    mkdirSync(dirname(where.out), { recursive: true });
    const have = existsSync(where.out) ? readFileSync(where.out, "utf8") : "";
    writeFileSync(where.out, `${have}${have === "" || have.endsWith("\n") ? "" : "\n"}${line}\n`);
  } catch (e) {
    logAndIgnore("add the worker settings file to the git exclude list")(e);
  }
};

const orca = (...args: string[]): { ok: boolean; out: string; err: string } => {
  try {
    const proc = Bun.spawnSync({ cmd: ["orca", ...args], stdout: "pipe", stderr: "pipe" });
    const text = (b: Uint8Array): string => new TextDecoder().decode(b).trim();
    return { ok: proc.exitCode === 0, out: text(proc.stdout), err: text(proc.stderr) };
  } catch (e) {
    return { ok: false, out: "", err: e instanceof Error ? e.message : String(e) };
  }
};

const canonical = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Makes sure Orca knows the folder, so `--worktree path:<folder>` is accepted. Returns an error text. */
const registerWithOrca = (dir: string): string | undefined => {
  const listed = orca("repo", "list", "--json");
  if (!listed.ok) return `orca repo list failed (is Orca running? \`orca open\`): ${listed.err || listed.out}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(listed.out);
  } catch {
    return "orca repo list did not return JSON";
  }
  const want = canonical(dir);
  if (orcaRepoPaths(parsed).some((p) => canonical(p) === want)) return undefined;
  const added = orca("repo", "add", "--path", dir, "--kind", "folder", "--json");
  return added.ok ? undefined : `orca repo add failed: ${added.err || added.out}`;
};

/** Writes the exclusions into the folder's settings file. Returns an exit code and what to say. */
const trimFolder = (dir: string, names: readonly string[]): number => {
  if (names.length === 0) {
    console.log("worker-mcp-trim: the host excludes no MCP server from workers, nothing to trim");
    return 0;
  }
  const file = join(dir, WORKER_SETTINGS_PATH);
  const merged = mergeDeniedServers(existsSync(file) ? readFileSync(file, "utf8") : undefined, names);
  if (!merged.ok) {
    console.error(`worker-mcp-trim: ${file}: ${merged.error}`);
    return 1;
  }
  if (merged.changed) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, merged.text);
    } catch (e) {
      console.error(`worker-mcp-trim: cannot write ${file}: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  keepOutOfGit(dir);
  console.log(
    merged.changed
      ? `worker-mcp-trim: ${file}: ${merged.added.length} MCP server${merged.added.length === 1 ? "" : "s"} excluded, start the worker now`
      : `worker-mcp-trim: ${file}: already excludes all ${names.length}, start the worker now`,
  );
  return 0;
};

const main = (): number => {
  if (process.argv.length > 3) {
    console.error("usage: worker-mcp-trim.ts [<folder>]");
    return 2;
  }
  const names = parseDenyList(process.env[WORKER_MCP_DENY_ENV]);
  const arg = process.argv[2];
  if (arg) {
    const dir = resolve(arg);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      console.error(`worker-mcp-trim: ${dir} is not a folder`);
      return 1;
    }
    return trimFolder(dir, names);
  }
  const home = process.env[WORKER_HOME_ENV];
  if (!home) {
    console.error(`worker-mcp-trim: no folder given and ${WORKER_HOME_ENV} is not set`);
    return 2;
  }
  const dir = resolve(home);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error(`worker-mcp-trim: cannot create ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  // Trim even when registering fails, so a retry only has the registration left to do.
  const trimmed = trimFolder(dir, names);
  const failed = registerWithOrca(dir);
  if (failed) {
    console.error(`worker-mcp-trim: ${dir}: ${failed}`);
    return 1;
  }
  if (trimmed === 0) console.log(`worker-mcp-trim: worker home ${dir} is ready: start the worker with --worktree path:${dir}`);
  return trimmed;
};

process.exit(main());
