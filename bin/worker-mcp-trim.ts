#!/usr/bin/env bun
//
// Keeps the host's chosen MCP servers out of the Orca worker about to start in a
// folder (see src/domain/workerMcp.ts for why this is a file and not a flag).
//
//   worker-mcp-trim.ts <folder>
//
// Adds the servers named in BOT_WORKER_MCP_DENY (the bot's WORKER_MCP_DENY, comma
// separated) to `deniedMcpServers` in <folder>/.claude/settings.local.json and keeps
// the file out of git. Run it BEFORE the worker launches: a session reads the file
// once, at start. Safe to repeat. With the variable empty it does nothing, so a
// prompt can call it unconditionally. A settings file it cannot read as JSON is left
// alone (exit 1).
//
// Exit: 0 done or nothing to do, 1 could not write, 2 usage.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { logAndIgnore } from "../src/application/ignoredError.ts";
import {
  mergeDeniedServers,
  parseDenyList,
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
 * line per repository; a folder that is not in a repository has nothing to exclude.
 */
const keepOutOfGit = (dir: string): void => {
  if (git(dir, "check-ignore", "-q", WORKER_SETTINGS_PATH).ok) return;
  const where = git(dir, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
  if (!where.ok || !where.out) return;
  try {
    mkdirSync(dirname(where.out), { recursive: true });
    const have = existsSync(where.out) ? readFileSync(where.out, "utf8") : "";
    writeFileSync(where.out, `${have}${have === "" || have.endsWith("\n") ? "" : "\n"}/${WORKER_SETTINGS_PATH}\n`);
  } catch (e) {
    logAndIgnore("add the worker settings file to the git exclude list")(e);
  }
};

const main = (): number => {
  const arg = process.argv[2];
  if (!arg || process.argv.length > 3) {
    console.error("usage: worker-mcp-trim.ts <folder>");
    return 2;
  }
  const dir = resolve(arg);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`worker-mcp-trim: ${dir} is not a folder`);
    return 1;
  }
  const names = parseDenyList(process.env[WORKER_MCP_DENY_ENV]);
  if (names.length === 0) {
    console.log("worker-mcp-trim: the host excludes no MCP server from workers, nothing to do");
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

process.exit(main());
