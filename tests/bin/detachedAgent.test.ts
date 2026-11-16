import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "..", "..", "bin", "detached-agent.sh");

// `claude` is a shim (CLAUDE_BIN): it records its argv, stdin and any
// CLAUDE_CODE_* it inherited, sleeps SLEEP seconds and exits with EXIT.
let dir: string;
let shim: string;
let prompt: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "detached-agent-"));
  shim = join(dir, "claude-shim");
  writeFileSync(
    shim,
    `#!/usr/bin/env bash
echo "args: $*"
echo "stdin: $(cat)"
echo "inherited: $(env | grep -c '^CLAUDE_CODE_\\|^CLAUDECODE=')"
sleep "\${SLEEP:-0}"
exit "\${EXIT:-0}"
`,
  );
  chmodSync(shim, 0o755);
  prompt = join(dir, "prompt.md");
  writeFileSync(prompt, "write the post");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[], env: Record<string, string> = {}) =>
  Bun.spawnSync(["bash", script, ...args], {
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, CLAUDE_BIN: shim, ...env },
    cwd: dir,
  });

const alive = (name: string) => run(["alive", join(dir, "run"), name]).exitCode;

const waitFor = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(50);
  }
  return false;
};

describe("bin/detached-agent.sh", () => {
  test("start returns at once, alive holds while it runs, the exit code is kept", async () => {
    const t0 = Date.now();
    const res = run(["start", join(dir, "run"), "w1", prompt, "--", "--model", "sonnet"], { SLEEP: "1", EXIT: "3" });
    expect(res.exitCode).toBe(0);
    expect(Date.now() - t0).toBeLessThan(900);
    expect(res.stdout.toString()).toContain("started w1 pid");
    expect(alive("w1")).toBe(0);

    expect(await waitFor(() => existsSync(join(dir, "run", "w1.exit")))).toBe(true);
    expect(alive("w1")).toBe(1);
    expect(readFileSync(join(dir, "run", "w1.exit"), "utf8").trim()).toBe("3");
    const log = readFileSync(join(dir, "run", "w1.log"), "utf8");
    expect(log).toContain("args: -p --dangerously-skip-permissions --model sonnet");
    expect(log).toContain("stdin: write the post");
  });

  test("the caller's CLAUDE_CODE_* never reach the agent", async () => {
    run(["start", join(dir, "run"), "w2", prompt], {
      CLAUDE_CODE_SESSION_ID: "parent",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDECODE: "1",
    });
    expect(await waitFor(() => existsSync(join(dir, "run", "w2.exit")))).toBe(true);
    expect(readFileSync(join(dir, "run", "w2.log"), "utf8")).toContain("inherited: 0");
  });

  test("the agent is not a child of the caller", () => {
    run(["start", join(dir, "run"), "w3", prompt], { SLEEP: "2" });
    const pid = readFileSync(join(dir, "run", "w3.pid"), "utf8").split("\n")[0] ?? "";
    const ppid = Bun.spawnSync(["ps", "-o", "ppid=", "-p", pid]).stdout.toString().trim();
    expect(ppid).not.toBe(String(process.pid));
    expect(ppid).not.toBe("");
    Bun.spawnSync(["kill", pid]);
  });

  test("survives the caller's process group and tree being killed", async () => {
    // The caller leads its own group (like a turn under launchd) and stays alive after start.
    const caller = Bun.spawn({
      cmd: ["bash", "-c", `bash '${script}' start '${join(dir, "run")}' w7 '${prompt}'; sleep 30`],
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, CLAUDE_BIN: shim, SLEEP: "3" },
      cwd: dir,
      detached: true,
    });
    expect(await waitFor(() => existsSync(join(dir, "run", "w7.pid")) && alive("w7") === 0)).toBe(true);
    const tree = (pid: number): number[] => {
      const kids = Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString().trim().split("\n").filter(Boolean).map(Number);
      return kids.flatMap((k) => [...tree(k), k]);
    };
    for (const p of [...tree(caller.pid), caller.pid]) Bun.spawnSync(["kill", "-9", String(p)]);
    Bun.spawnSync(["kill", "-9", `-${caller.pid}`]);
    await caller.exited;
    await Bun.sleep(200);
    expect(alive("w7")).toBe(0);
    Bun.spawnSync(["kill", readFileSync(join(dir, "run", "w7.pid"), "utf8").split("\n")[0] ?? ""]);
  });

  test("a pid recorded without a start time is not alive", () => {
    writeFileSync(join(dir, "w8.pid"), `${process.pid}\n\n`);
    expect(run(["alive", dir, "w8"]).exitCode).toBe(1);
  });

  test("refuses a second start while the first is alive", () => {
    expect(run(["start", join(dir, "run"), "w4", prompt], { SLEEP: "2" }).exitCode).toBe(0);
    const again = run(["start", join(dir, "run"), "w4", prompt]);
    expect(again.exitCode).toBe(2);
    expect(again.stderr.toString()).toContain("already running");
    Bun.spawnSync(["kill", readFileSync(join(dir, "run", "w4.pid"), "utf8").split("\n")[0] ?? ""]);
  });

  test("a recycled pid is not read as alive", () => {
    // Our own pid is alive, but with a start time that is not its own.
    writeFileSync(join(dir, "w5.pid"), `${process.pid}\nThu Jan  1 00:00:00 1970\n`);
    expect(run(["alive", dir, "w5"]).exitCode).toBe(1);
  });

  test("never started, a bad name or a missing prompt", () => {
    expect(alive("nope")).toBe(1);
    expect(run(["start", join(dir, "run"), "../x", prompt]).exitCode).toBe(2);
    expect(run(["start", join(dir, "run"), "w6", join(dir, "missing.md")]).exitCode).toBe(2);
    expect(run([]).exitCode).toBe(2);
  });
});
