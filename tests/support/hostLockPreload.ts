// Preloaded by bunfig.toml `[test] preload`, so a plain `bun test` queues behind other full runs on
// this host. Top-level await holds the run until the lock is ours; it is released when the process
// ends (a killed process leaves a stale lock, which the next waiter reaps by pid).
import { afterAll } from "bun:test";
import { setPriority } from "node:os";
import {
  acquire, commandLine, HELD_ENV, lockDir, isLockTimeout, niceValue, planLock, processStart, timeoutMs,
  type LockHolder,
} from "./hostLock.ts";

const env = process.env;
const plan = planLock(env, commandLine(process.pid) ?? []);

if (plan.use) {
  try {
    setPriority(process.pid, niceValue(env));
  } catch {
    /* lowering priority is best effort */
  }
  const limit = timeoutMs(env);
  let lastTold = -Infinity;
  const who = (h: LockHolder | null): string => (h ? `pid ${h.pid}${h.cwd ? ` in ${h.cwd}` : ""}` : "another run");
  try {
    const lock = await acquire({
      dir: lockDir(env),
      timeoutMs: limit,
      pollMs: 1000,
      pid: process.pid,
      cwd: process.cwd(),
      startOf: processStart,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      onWait: (holder, waited) => {
        if (waited - lastTold < 30_000) return;
        lastTold = waited;
        console.error(
          `[test-lock] another full "bun test" is running on this host (${who(holder)}); waiting my turn, ${Math.round(waited / 1000)}s so far (gives up after ${Math.round(limit / 1000)}s: JARVIS_TEST_LOCK_TIMEOUT_MS; skip the queue: JARVIS_TEST_LOCK=0)`,
        );
      },
    });
    process.env[HELD_ENV] = String(process.pid);
    // bun test leaves through a native exit that skips `exit` listeners, so the end of the run releases too
    afterAll(lock.release);
    process.on("exit", lock.release);
    for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
      process.on(sig, () => {
        lock.release();
        process.exit(code);
      });
    }
  } catch (e) {
    if (!isLockTimeout(e)) throw e;
    console.error(
      `[test-lock] gave up after ${Math.round(e.waitedMs / 1000)}s: another full "bun test" still holds ${e.path} (${who(e.holder)}). ` +
        `Raise JARVIS_TEST_LOCK_TIMEOUT_MS, run one file (\`bun test path/x.test.ts\` skips the queue) or set JARVIS_TEST_LOCK=0 to run anyway.`,
    );
    process.exit(1);
  }
}
