import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquire, HELD_ENV, isLockTimeout, isTargetedRun, lockDir, niceValue, planLock, processStart, timeoutMs,
  type LockOptions,
} from "./hostLock.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hostlock-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lockPath = () => join(dir, "bun-test.lock");

// a pid that is certainly dead: a finished child
const deadPid = (): number => Bun.spawnSync(["true"]).pid ?? 999_999_999;

const opts = (over: Partial<LockOptions> = {}): LockOptions => ({
  dir,
  timeoutMs: 2000,
  pollMs: 5,
  pid: process.pid,
  cwd: "/work/a",
  startOf: () => "t0",
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  ...over,
});

describe("planLock", () => {
  const full = ["bun", "test"];
  test("a plain full run takes the lock", () => {
    expect(planLock({}, full)).toEqual({ use: true });
    expect(planLock({}, ["bun", "test", "--bail", "--timeout", "5000"])).toEqual({ use: true });
  });
  test("JARVIS_TEST_LOCK=0 disables it", () => {
    for (const v of ["0", "false", "off", "no"]) expect(planLock({ JARVIS_TEST_LOCK: v }, full)).toEqual({ use: false, why: "disabled" });
    expect(planLock({ JARVIS_TEST_LOCK: "1" }, full)).toEqual({ use: true });
  });
  test("CI is a no-op", () => {
    expect(planLock({ CI: "true" }, full)).toEqual({ use: false, why: "ci" });
    expect(planLock({ CI: "1" }, full)).toEqual({ use: false, why: "ci" });
    expect(planLock({ CI: "false" }, full)).toEqual({ use: true });
    expect(planLock({ CI: "" }, full)).toEqual({ use: true });
  });
  test("a run inside a locked run does not queue behind it", () => {
    expect(planLock({ [HELD_ENV]: "123" }, full)).toEqual({ use: false, why: "nested" });
  });
  test("a file or name filter skips the lock", () => {
    expect(planLock({}, ["bun", "test", "src/x.test.ts"])).toEqual({ use: false, why: "targeted" });
  });
});

describe("isTargetedRun", () => {
  test("detects positional filters, not flag values", () => {
    expect(isTargetedRun(["bun", "test"])).toBe(false);
    expect(isTargetedRun(["bun", "test", "--timeout", "5000"])).toBe(false);
    expect(isTargetedRun(["bun", "test", "-t", "some name"])).toBe(false);
    expect(isTargetedRun(["bun", "test", "--bail"])).toBe(false);
    expect(isTargetedRun(["bun", "test", "tests/a.test.ts"])).toBe(true);
    expect(isTargetedRun(["bun", "test", "--bail", "tests/"])).toBe(true);
    expect(isTargetedRun(["bun", "test", "--timeout", "5000", "foo"])).toBe(true);
    expect(isTargetedRun(["bun", "test", "--", "foo"])).toBe(true);
  });
  test("a command that is not `bun test` is not targeted", () => {
    expect(isTargetedRun(["bun", "run", "x.ts"])).toBe(false);
  });
});

describe("env knobs", () => {
  test("lock dir: override, else under the home cache, never the worktree", () => {
    expect(lockDir({ JARVIS_TEST_LOCK_DIR: "/x/y" })).toBe("/x/y");
    expect(lockDir({ HOME: "/home/u" })).toBe("/home/u/.cache/jarvis-test-lock");
  });
  test("timeout and nice fall back on junk", () => {
    expect(timeoutMs({})).toBe(30 * 60_000);
    expect(timeoutMs({ JARVIS_TEST_LOCK_TIMEOUT_MS: "1500" })).toBe(1500);
    expect(timeoutMs({ JARVIS_TEST_LOCK_TIMEOUT_MS: "abc" })).toBe(30 * 60_000);
    expect(niceValue({})).toBe(10);
    expect(niceValue({ JARVIS_TEST_NICE: "5" })).toBe(5);
    expect(niceValue({ JARVIS_TEST_NICE: "-5" })).toBe(10);
    expect(niceValue({ JARVIS_TEST_NICE: "99" })).toBe(10);
  });
});

describe("processStart", () => {
  const startUnder = (env: Record<string, string>) => {
    const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(process.pid)], { env: { ...process.env, ...env } });
    return r.stdout.toString().trim();
  };
  test("is the same string whatever TZ and locale the caller runs in", () => {
    const here = processStart(process.pid);
    expect(here).toBeTruthy();
    // sanity: a raw `ps` does differ by TZ, which is what the pin guards against
    expect(startUnder({ TZ: "UTC" })).not.toBe(startUnder({ TZ: "Pacific/Kiritimati" }));
    const other = Bun.spawnSync(
      ["bun", "-e", `import { processStart } from "${join(import.meta.dir, "hostLock.ts")}"; console.log(processStart(${process.pid}))`],
      { env: { ...process.env, TZ: "Pacific/Kiritimati", LC_ALL: "fr_FR.UTF-8" } },
    );
    expect(other.stdout.toString().trim()).toBe(here as string);
  });
  test("a dead pid has none", () => {
    expect(processStart(deadPid())).toBeNull();
  });
});

describe("acquire", () => {
  test("takes a free lock, records the holder, releases it", async () => {
    const lock = await acquire(opts());
    expect(JSON.parse(readFileSync(lockPath(), "utf8"))).toEqual({ pid: process.pid, started: "t0", cwd: "/work/a" });
    lock.release();
    expect(existsSync(lockPath())).toBe(false);
    lock.release(); // idempotent
  });

  test("a second run waits until the first releases, then goes", async () => {
    const order: string[] = [];
    const first = await acquire(opts());
    const waits: number[] = [];
    const second = acquire(opts({ onWait: (_h, w) => waits.push(w) })).then((l) => {
      order.push("second");
      return l;
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(order).toEqual([]);
    expect(waits.length).toBeGreaterThan(0);
    order.push("first-release");
    first.release();
    const l2 = await second;
    expect(order).toEqual(["first-release", "second"]);
    l2.release();
  });

  test("a lock left by a dead process is taken over at once", async () => {
    writeFileSync(lockPath(), JSON.stringify({ pid: deadPid(), started: "t0", cwd: "/gone" }));
    const lock = await acquire(opts({ timeoutMs: 500 }));
    expect(JSON.parse(readFileSync(lockPath(), "utf8")).pid).toBe(process.pid);
    lock.release();
  });

  test("a live pid that started at another time is a reused pid: stale", async () => {
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, started: "long ago", cwd: "/old" }));
    const lock = await acquire(opts({ timeoutMs: 500, startOf: () => "now" }));
    lock.release();
    expect(existsSync(lockPath())).toBe(false);
  });

  test("an old unparseable lock file is garbage, a fresh one is a holder mid-write", async () => {
    writeFileSync(lockPath(), "{");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath(), old, old);
    (await acquire(opts({ timeoutMs: 500 }))).release();

    writeFileSync(lockPath(), "{");
    let err: unknown;
    await acquire(opts({ timeoutMs: 50 })).catch((e) => (err = e));
    expect(isLockTimeout(err)).toBe(true);
  });

  test("times out with the holder named when a live run keeps the lock", async () => {
    const held = await acquire(opts());
    let err: unknown;
    await acquire(opts({ timeoutMs: 80 })).catch((e) => (err = e));
    expect(isLockTimeout(err)).toBe(true);
    if (isLockTimeout(err)) {
      expect(err.holder?.pid).toBe(process.pid);
      expect(err.holder?.cwd).toBe("/work/a");
      expect(err.path).toBe(lockPath());
      expect(err.message).toContain("timed out");
    }
    expect(existsSync(lockPath())).toBe(true);
    held.release();
  });

  test("release never removes a lock somebody else took over", async () => {
    const lock = await acquire(opts());
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid + 1, started: null, cwd: "/other" }));
    lock.release();
    expect(existsSync(lockPath())).toBe(true);
  });

  test("two waiters on a stale lock: exactly one wins, the other queues", async () => {
    writeFileSync(lockPath(), JSON.stringify({ pid: deadPid(), started: null, cwd: "/gone" }));
    const a = acquire(opts({ cwd: "/a", timeoutMs: 300 }));
    const b = acquire(opts({ cwd: "/b", timeoutMs: 300 }));
    const settled = await Promise.allSettled([a, b]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const lost = settled.find((s) => s.status === "rejected");
    expect(isLockTimeout((lost as PromiseRejectedResult).reason)).toBe(true);
  });
});

describe("the preload, end to end", () => {
  const preload = join(import.meta.dir, "hostLockPreload.ts");
  const run = (env: Record<string, string>, target: string[]) =>
    Bun.spawnSync(["bun", "test", "--preload", preload, ...target], {
      cwd: dir,
      env: { ...process.env, CI: "", [HELD_ENV]: "", JARVIS_TEST_LOCK_DIR: join(dir, "locks"), ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
  beforeEach(() => writeFileSync(join(dir, "empty.test.ts"), 'import {test} from "bun:test"; test("x", () => {});'));

  // a bare `bun test` in a scratch folder whose bunfig preloads the real preload
  const bare = (env: Record<string, string>) => {
    writeFileSync(join(dir, "bunfig.toml"), `[test]\npreload = ["${preload}"]\n`);
    return run(env, []);
  };

  test("a targeted run skips the queue even while the lock is held", async () => {
    const held = await acquire(opts({ dir: join(dir, "locks"), startOf: processStart }));
    expect(run({ JARVIS_TEST_LOCK_TIMEOUT_MS: "300" }, ["./empty.test.ts"]).exitCode).toBe(0);
    held.release();
  });

  test("a plain `bun test` gives up with a clear message while another run holds the lock", async () => {
    const held = await acquire(opts({ dir: join(dir, "locks"), startOf: processStart }));
    const r = bare({ JARVIS_TEST_LOCK_TIMEOUT_MS: "1500" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("[test-lock] gave up");
    expect(r.stderr.toString()).toContain("JARVIS_TEST_LOCK_TIMEOUT_MS");
    held.release();
  });

  test("JARVIS_TEST_LOCK=0 and CI=true run straight through a held lock", async () => {
    const held = await acquire(opts({ dir: join(dir, "locks"), startOf: processStart }));
    expect(bare({ JARVIS_TEST_LOCK_TIMEOUT_MS: "300", JARVIS_TEST_LOCK: "0" }).exitCode).toBe(0);
    expect(bare({ JARVIS_TEST_LOCK_TIMEOUT_MS: "300", CI: "true" }).exitCode).toBe(0);
    held.release();
  });

  test("a holder started under another TZ is still seen as alive: the waiter queues", async () => {
    const hold = Bun.spawn(
      ["bun", "-e", `import { acquire, processStart } from "${join(import.meta.dir, "hostLock.ts")}"; await acquire({ dir: "${join(dir, "locks")}", timeoutMs: 1000, pollMs: 5, pid: process.pid, cwd: "/h", startOf: processStart, now: Date.now, sleep: (m) => new Promise((r) => setTimeout(r, m)) }); console.log("held"); await new Promise((r) => setTimeout(r, 6000));`],
      { env: { ...process.env, TZ: "Pacific/Kiritimati", LC_ALL: "fr_FR.UTF-8" }, stdout: "pipe" },
    );
    await hold.stdout.getReader().read(); // "held"
    const r = bare({ JARVIS_TEST_LOCK_TIMEOUT_MS: "1500" });
    hold.kill();
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("[test-lock] gave up");
  });

  test("a plain `bun test` takes the lock, runs, and leaves none behind", () => {
    const locks = join(dir, "locks");
    expect(bare({}).exitCode).toBe(0);
    expect(existsSync(join(locks, "bun-test.lock"))).toBe(false);
  });

  test("a plain `bun test` over a dead holder's lock proceeds", () => {
    const locks = join(dir, "locks");
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, "bun-test.lock"), JSON.stringify({ pid: deadPid(), started: null, cwd: "/gone" }));
    expect(bare({ JARVIS_TEST_LOCK_TIMEOUT_MS: "5000" }).exitCode).toBe(0);
  });
});
