#!/usr/bin/env bun
//
// Every desktop action goes through here, so two sessions never drive the
// screen at once (see src/domain/desktopLock.ts for why).
//
//   desktop.ts mac-ui <args...>          run bin/mac-ui.js under the lock
//   desktop.ts agent-desktop <args...>   run agent-desktop under the lock
//   desktop.ts free                      exit 0 when this session may act (for a watch)
//   desktop.ts status                    who holds the screen, as JSON
//   desktop.ts release                   give the screen back (own lock only)
//
// Every action ends with `mac-ui.js release-keys`, so no modifier stays held.
//
// Read-only commands (tree, snapshot, screenshot...) skip the lock. A refused
// action exits 75 (EX_TEMPFAIL) with the holder on stderr.
//
// The holder is BOT_SESSION_ID. The lock file is JARVIS_DESKTOP_LOCK, default
// <tmpdir>/jarvis-desktop.lock.
import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  busyMessage,
  decideDesktopLock,
  isDesktopDriver,
  isDesktopFree,
  isReadOnly,
  releasesKeysAfter,
  type DesktopDriver,
  type DesktopLock,
} from "../src/domain/desktopLock.ts";

const BUSY_EXIT = 75;
const lockPath = process.env.JARVIS_DESKTOP_LOCK || join(tmpdir(), "jarvis-desktop.lock");
const mutexPath = `${lockPath}.mutex`;
const me = process.env.BOT_SESSION_ID || "anonymous";
const self = import.meta.path;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A short critical section around read-modify-write of the lock file. */
const withMutex = async <T>(fn: () => T): Promise<T> => {
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(mutexPath, "wx"));
      break;
    } catch {
      // a writer that died inside the section leaves the mutex behind
      try {
        if (Date.now() - statSync(mutexPath).mtimeMs > 10_000) rmSync(mutexPath, { force: true });
      } catch {}
      if (i > 200) throw new Error(`desktop lock: could not get ${mutexPath}`);
      await sleep(10);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(mutexPath, { force: true });
  }
};

const readLock = (): DesktopLock | null => {
  try {
    const v: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    if (typeof v !== "object" || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.holder !== "string" || typeof o.since !== "number" || typeof o.last !== "number") return null;
    return { holder: o.holder, since: o.since, last: o.last, action: typeof o.action === "string" ? o.action : "" };
  } catch {
    return null;
  }
};

const writeLock = (lock: DesktopLock): void => {
  const tmp = `${lockPath}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(lock));
  renameSync(tmp, lockPath);
};

const driverCmd = (driver: DesktopDriver): string[] => {
  if (driver === "mac-ui") return ["osascript", "-l", "JavaScript", join(import.meta.dir, "mac-ui.js")];
  const bin = Bun.which("agent-desktop", { PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` });
  if (!bin) {
    console.error("agent-desktop is not installed");
    process.exit(127);
  }
  return [bin];
};

const [first, ...rest] = process.argv.slice(2);

if (first === "free") process.exit(isDesktopFree(readLock(), me, Date.now()) ? 0 : 1);
if (first === "status") {
  console.log(JSON.stringify({ me, lock: readLock(), free: isDesktopFree(readLock(), me, Date.now()) }));
  process.exit(0);
}
if (first === "release") {
  const released = await withMutex(() => {
    const cur = readLock();
    if (cur?.holder !== me) return false;
    rmSync(lockPath, { force: true });
    return true;
  });
  console.log(JSON.stringify({ released }));
  process.exit(0);
}
if (!first || !isDesktopDriver(first)) {
  console.error("usage: desktop.ts <mac-ui|agent-desktop> <args...> | free | status | release");
  process.exit(2);
}

const driver = first;
if (!isReadOnly(driver, rest)) {
  const action = `${driver} ${rest.join(" ")}`.slice(0, 120);
  const decision = await withMutex(() => {
    const d = decideDesktopLock(readLock(), me, action, Date.now());
    if (d.kind === "take") writeLock(d.lock);
    return d;
  });
  if (decision.kind === "busy") {
    console.error(busyMessage(decision.lock, Date.now(), `${self} free`));
    process.exit(BUSY_EXIT);
  }
}

const proc = Bun.spawn({ cmd: [...driverCmd(driver), ...rest], stdin: "inherit", stdout: "inherit", stderr: "inherit" });
const code = await proc.exited;
// Even after a failed action: a modifier left down turns every later keystroke
// into a shortcut on the real screen.
if (releasesKeysAfter(driver, rest)) {
  await Bun.spawn({ cmd: [...driverCmd("mac-ui"), "release-keys"], stdout: "ignore", stderr: "ignore" }).exited;
}
process.exit(code);
