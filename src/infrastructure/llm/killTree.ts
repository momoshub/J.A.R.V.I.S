/**
 * Kill a process AND everything it started.
 *
 * `proc.kill()` signals the one process it spawned, which is not what stopping
 * a turn means. The CLI runs the model's shell commands as its own children, so
 * a turn stuck inside a 15-minute `find` was SIGTERM'd and simply carried on:
 * the shell was blocked waiting on `find`, the signal changed nothing, and the
 * `find` kept running regardless. Measured on this machine: after `proc.kill()`
 * the parent's exit code was still null and two grandchildren were orphaned.
 *
 * That is why pressing stop appeared to do nothing - the process it pointed at
 * never died, so the run never unwound and the next press said "stopped" again.
 *
 * Children are collected BEFORE the parent is signalled. Kill the parent first
 * and its children are reparented to init, at which point they cannot be found
 * from the pid we were given.
 */

/** Direct children of a pid, via pgrep. Empty on any failure - never throws. */
const childrenOf = (pid: number): number[] => {
  try {
    const out = Bun.spawnSync({ cmd: ["pgrep", "-P", String(pid)], stdout: "pipe", stderr: "ignore" });
    return new TextDecoder()
      .decode(out.stdout)
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
};

/** Signal a whole process tree, deepest first. Safe to call on a dead pid. */
export const killTree = (pid: number, signal: NodeJS.Signals = "SIGTERM"): void => {
  if (!Number.isInteger(pid) || pid <= 1) return;
  for (const child of childrenOf(pid)) killTree(child, signal);
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone, or not ours to signal. Either way there is nothing to do.
  }
};

/** How long a tree gets to exit on SIGTERM before it is taken out with SIGKILL. */
export const KILL_GRACE_MS = 5_000;

/**
 * Stop a spawned process properly: ask, then insist.
 *
 * SIGTERM first so the CLI can flush its session file - a resumed turn depends
 * on it - then SIGKILL the tree if anything is still standing. The timer is
 * unref'd so a pending hard kill never holds the process open.
 */
export const stopProcess = (
  proc: { pid?: number; kill: () => void; exitCode: number | null },
  graceMs = KILL_GRACE_MS,
): void => {
  const pid = proc.pid;
  if (!pid) {
    proc.kill();
    return;
  }
  killTree(pid, "SIGTERM");
  const hard = setTimeout(() => {
    if (proc.exitCode === null) killTree(pid, "SIGKILL");
  }, graceMs);
  hard.unref?.();
};
