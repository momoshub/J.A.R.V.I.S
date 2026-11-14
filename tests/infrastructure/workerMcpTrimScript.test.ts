import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "bin", "worker-mcp-trim.ts");

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "worker-mcp-trim-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// The host's own git config may already ignore this file (Claude Code adds it to the global
// ignore list), which would hide whether the helper does it: give git an empty home.
const hermetic = (): Record<string, string | undefined> => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  XDG_CONFIG_HOME: join(root, "xdg"),
});

const sh = (cwd: string, ...cmd: string[]) => {
  const p = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe", env: hermetic() });
  return { code: p.exitCode, out: new TextDecoder().decode(p.stdout).trim() };
};

const run = async (args: string[], deny: string | undefined) => {
  const env = hermetic();
  delete env.BOT_WORKER_MCP_DENY;
  if (deny !== undefined) env.BOT_WORKER_MCP_DENY = deny;
  const proc = Bun.spawn({ cmd: [process.execPath, SCRIPT, ...args], stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
};

const settingsOf = (dir: string) => JSON.parse(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8"));

/** A repository with one commit and a linked worktree, the shape Orca makes. */
const repoWithWorktree = () => {
  const repo = join(root, "repo");
  mkdirSync(repo);
  sh(repo, "git", "init", "-q", "-b", "main");
  sh(repo, "git", "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const wt = join(root, "wt");
  expect(sh(repo, "git", "worktree", "add", "-q", wt, "-b", "feature").code).toBe(0);
  return { repo, wt };
};

describe("bin/worker-mcp-trim.ts", () => {
  test("writes the named servers into the folder's settings and says to start the worker", async () => {
    const dir = join(root, "plain");
    mkdirSync(dir);
    const r = await run([dir], "pg-prod, ch-ro");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("2 MCP servers excluded");
    expect(settingsOf(dir)).toEqual({ deniedMcpServers: [{ serverName: "pg-prod" }, { serverName: "ch-ro" }] });
  });

  test("with nothing excluded it does nothing and writes no file", async () => {
    const dir = join(root, "plain");
    mkdirSync(dir);
    for (const deny of [undefined, "", " , "]) {
      const r = await run([dir], deny);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("nothing to do");
    }
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  });

  test("keeps the rest of an existing settings file and is safe to repeat", async () => {
    const dir = join(root, "plain");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
    expect((await run([dir], "pg-prod")).code).toBe(0);
    const once = readFileSync(join(dir, ".claude", "settings.local.json"), "utf8");
    const again = await run([dir], "pg-prod");
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("already excludes all 1");
    expect(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8")).toBe(once);
    expect(settingsOf(dir)).toEqual({ permissions: { allow: ["Bash(ls:*)"] }, deniedMcpServers: [{ serverName: "pg-prod" }] });
  });

  test("a settings file it cannot read is left exactly as it was", async () => {
    const dir = join(root, "plain");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const file = join(dir, ".claude", "settings.local.json");
    writeFileSync(file, "{not json");
    const r = await run([dir], "pg-prod");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not valid JSON");
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  test("in a repository the file is kept out of git, for the checkout and its linked worktree", async () => {
    const { repo, wt } = repoWithWorktree();
    expect((await run([wt], "pg-prod")).code).toBe(0);
    // untracked and ignored: `git add -A` in the worktree must not pick it up
    expect(sh(wt, "git", "status", "--porcelain").out).toBe("");
    expect(sh(wt, "git", "check-ignore", "-q", ".claude/settings.local.json").code).toBe(0);
    // one line in the repository's own exclude list, not one per run
    expect((await run([wt], "pg-prod")).code).toBe(0);
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === "/.claude/settings.local.json")).toHaveLength(1);
  });

  test("a file the repository already ignores adds no second exclude line", async () => {
    const { repo, wt } = repoWithWorktree();
    writeFileSync(join(repo, ".git", "info", "exclude"), ".claude/settings.local.json\n");
    expect((await run([wt], "pg-prod")).code).toBe(0);
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toBe(".claude/settings.local.json\n");
  });

  test("a missing folder or no argument is refused", async () => {
    const missing = await run([join(root, "nope")], "pg-prod");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("is not a folder");
    expect((await run([], "pg-prod")).code).toBe(2);
    expect((await run([root, "extra"], "pg-prod")).code).toBe(2);
  });
});
