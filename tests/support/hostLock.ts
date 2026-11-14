// Host-wide queue for full `bun test` runs. Several worktrees (bot turns, workers, the restart
// helper) each running the whole suite at once loads an 8-core machine to 20+ and starves
// everything else, so a full run takes this lock first and the others wait their turn.
// Portable on purpose: an exclusive-create file plus a pid check, no `flock` binary (macOS has none).
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type LockEnv = Readonly<Record<string, string | undefined>>;

export type LockHolder = { readonly pid: number; readonly started: string | null; readonly cwd: string };

export type LockOptions = {
  readonly dir: string;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly pid: number;
  readonly cwd: string;
  /** Start time of a pid (any stable string), null when it does not run. Guards against a reused pid. */
  readonly startOf: (pid: number) => string | null;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onWait?: (holder: LockHolder | null, waitedMs: number) => void;
};

export type Lock = { readonly release: () => void };

export const DEFAULT_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_NICE = 10;
/** Set to the holder's pid for the lifetime of a locked run, so a `bun test` it spawns does not queue behind it. */
export const HELD_ENV = "JARVIS_TEST_LOCK_HELD";

const LOCK_FILE = "bun-test.lock";
const REAP_FILE = "bun-test.lock.reap";
const REAP_STALE_MS = 10_000;

/** Flags of `bun test` that take a value; the word after one is not a path filter. */
const VALUE_FLAGS = new Set([
  "-t", "--test-name-pattern", "--timeout", "--rerun-each", "--preload", "-r", "--config", "-c",
  "--coverage-reporter", "--coverage-dir", "--reporter", "--reporter-outfile", "--max-concurrency",
  "--env-file", "--cwd", "--seed", "--shard",
]);

const isOff = (v: string | undefined): boolean => v !== undefined && /^(0|false|off|no)$/i.test(v.trim());
const isOn = (v: string | undefined): boolean => v !== undefined && v.trim() !== "" && !isOff(v);

/** GitHub Actions and most CI set CI=true; a dedicated runner has no neighbours to queue behind. */
export const isCi = (env: LockEnv): boolean => isOn(env.CI);

/** True when the command line names a file, directory or name filter: a cheap run that skips the queue. */
export const isTargetedRun = (argv: readonly string[]): boolean => {
  const at = argv.indexOf("test");
  const args = at < 0 ? [] : argv.slice(at + 1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") return i + 1 < args.length;
    if (a.startsWith("-")) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    return true;
  }
  return false;
};

export type Plan =
  | { readonly use: false; readonly why: "disabled" | "ci" | "targeted" | "nested" }
  | { readonly use: true };

export const planLock = (env: LockEnv, argv: readonly string[]): Plan => {
  if (isOff(env.JARVIS_TEST_LOCK)) return { use: false, why: "disabled" };
  if (isCi(env)) return { use: false, why: "ci" };
  if (isOn(env[HELD_ENV])) return { use: false, why: "nested" };
  if (isTargetedRun(argv)) return { use: false, why: "targeted" };
  return { use: true };
};

export const lockDir = (env: LockEnv): string => {
  const fromEnv = env.JARVIS_TEST_LOCK_DIR?.trim();
  if (fromEnv) return fromEnv;
  const home = env.HOME?.trim() || homedir();
  return join(home ? join(home, ".cache") : tmpdir(), "jarvis-test-lock");
};

export const timeoutMs = (env: LockEnv): number => {
  const n = Number(env.JARVIS_TEST_LOCK_TIMEOUT_MS);
  return env.JARVIS_TEST_LOCK_TIMEOUT_MS?.trim() && Number.isFinite(n) && n >= 0 ? n : DEFAULT_TIMEOUT_MS;
};

export const niceValue = (env: LockEnv): number => {
  const n = Number(env.JARVIS_TEST_NICE);
  return env.JARVIS_TEST_NICE?.trim() && Number.isInteger(n) && n >= 0 && n <= 19 ? n : DEFAULT_NICE;
};

// `ps` prints local time in the caller's locale: pin both, or two runs started from a terminal, launchd and a
// worker (different TZ/LANG) would read the same holder's start differently and reap a live lock.
const PS_ENV = { ...process.env, TZ: "UTC", LC_ALL: "C" };

export const processStart = (pid: number): string | null => {
  const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", env: PS_ENV });
  const out = r.stdout.toString().trim();
  return r.exitCode === 0 && out ? out : null;
};

/**
 * The command line of a running pid, split on spaces. `process.argv` cannot be used for this:
 * inside a `bun test` preload it holds the bun binary and the first test file, not what was typed.
 */
export const commandLine = (pid: number): readonly string[] | null => {
  try {
    // Linux keeps the exact argv, NUL separated, so a quoted `-t "foo bar"` stays one word
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (raw) return raw.split("\0").filter((a) => a !== "");
  } catch {
    /* no procfs (macOS): fall back on ps */
  }
  const r = Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const out = r.stdout.toString().trim();
  return r.exitCode === 0 && out ? out.split(/\s+/) : null;
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readHolder = (path: string): LockHolder | null | "gone" => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return "gone";
  }
  try {
    const j = JSON.parse(raw) as Partial<LockHolder>;
    if (typeof j.pid !== "number") return null;
    return { pid: j.pid, started: typeof j.started === "string" ? j.started : null, cwd: String(j.cwd ?? "") };
  } catch {
    return null; // half written or garbage: judged by its age by the caller
  }
};

const holderAlive = (h: LockHolder, startOf: LockOptions["startOf"]): boolean => {
  if (!pidAlive(h.pid)) return false;
  const now = startOf(h.pid);
  return h.started === null || now === null || now === h.started;
};

const ageMs = (path: string, now: number): number => {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

const tryCreate = (path: string, holder: LockHolder): boolean => {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify(holder));
  } finally {
    closeSync(fd);
  }
  return true;
};

const unlinkQuiet = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
};

/** Removes the lock when its holder is dead. Serialised by a short-lived reap file so two waiters cannot both unlink a fresh lock. */
const reapIfStale = (dir: string, o: LockOptions): void => {
  const lock = join(dir, LOCK_FILE);
  const reap = join(dir, REAP_FILE);
  if (!tryCreate(reap, { pid: o.pid, started: null, cwd: o.cwd })) {
    if (ageMs(reap, o.now()) > REAP_STALE_MS) unlinkQuiet(reap);
    return;
  }
  try {
    const h = readHolder(lock);
    if (h === "gone") return;
    // an unparseable file is a holder caught mid-write: only old ones are garbage
    if (h === null ? ageMs(lock, o.now()) > REAP_STALE_MS : !holderAlive(h, o.startOf)) unlinkQuiet(lock);
  } finally {
    unlinkQuiet(reap);
  }
};

export type LockTimeout = Error & { readonly lockTimeout: true; readonly holder: LockHolder | null; readonly waitedMs: number; readonly path: string };

const lockTimeout = (holder: LockHolder | null, waitedMs: number, path: string): LockTimeout =>
  Object.assign(new Error(`timed out after ${Math.round(waitedMs / 1000)}s waiting for the host test lock ${path}`), {
    lockTimeout: true as const,
    holder,
    waitedMs,
    path,
  });

export const isLockTimeout = (e: unknown): e is LockTimeout => e instanceof Error && (e as Partial<LockTimeout>).lockTimeout === true;

/** Waits for the lock and returns its release. Throws `LockTimeout` after `timeoutMs`. */
export const acquire = async (o: LockOptions): Promise<Lock> => {
  mkdirSync(o.dir, { recursive: true });
  const path = join(o.dir, LOCK_FILE);
  const mine: LockHolder = { pid: o.pid, started: o.startOf(o.pid), cwd: o.cwd };
  const began = o.now();
  for (;;) {
    if (tryCreate(path, mine)) break;
    reapIfStale(o.dir, o);
    if (tryCreate(path, mine)) break;
    const waited = o.now() - began;
    const holder = readHolder(path);
    const shown = holder === "gone" ? null : holder;
    if (waited >= o.timeoutMs) throw lockTimeout(shown, waited, path);
    o.onWait?.(shown, waited);
    await o.sleep(Math.min(o.pollMs, Math.max(1, o.timeoutMs - waited)));
  }
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      const h = readHolder(path);
      if (h !== "gone" && h !== null && h.pid === o.pid) unlinkQuiet(path);
    },
  };
};
