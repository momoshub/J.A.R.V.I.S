/**
 * One screen, one driver at a time.
 *
 * The gap: one session was creating users in Brave while a second, asked to
 * deactivate others "in a small window", opened its own. The new window took
 * focus, the first session's clicks landed in it, and a reset-password link
 * was generated for a user nobody meant to touch. Each thread has its own CLI
 * session and none of them knew the others were on the screen - the drivers
 * ran every click they were given.
 *
 * So every action that can move focus or type goes through `bin/desktop.ts`,
 * which takes a desktop-wide lock keyed on the session (`BOT_SESSION_ID`).
 * A second session is refused with who holds it, and waits on `free` with a
 * watch rather than opening another window. Reading the screen (a tree, a
 * snapshot, a screenshot) needs no lock: it moves nothing.
 *
 * The lock lapses after `DESKTOP_LOCK_TTL_MS` of no actions, so a turn that
 * died mid-job cannot hold the screen forever. Its holder can `release` it
 * as soon as it is done.
 */

export type DesktopDriver = "mac-ui" | "agent-desktop";

export type DesktopLock = {
  /** Session that is driving the screen. */
  readonly holder: string;
  /** When it took the lock, epoch ms. */
  readonly since: number;
  /** Its last action, epoch ms. The TTL counts from here. */
  readonly last: number;
  /** What that last action was, for the busy message. */
  readonly action: string;
};

export type LockDecision =
  | { readonly kind: "take"; readonly lock: DesktopLock }
  | { readonly kind: "busy"; readonly lock: DesktopLock };

/** Idle time after which a holder's lock no longer counts. */
export const DESKTOP_LOCK_TTL_MS = 5 * 60_000;

const READ_ONLY: Record<DesktopDriver, ReadonlySet<string>> = {
  "mac-ui": new Set(["apps", "tree", "find", "read", "windows"]),
  "agent-desktop": new Set([
    "snapshot", "find", "screenshot", "get", "is", "skills", "help", "version",
    "list-windows", "list-displays", "list-apps", "list-surfaces", "list-notifications",
  ]),
};

export const isDesktopDriver = (name: string): name is DesktopDriver =>
  name === "mac-ui" || name === "agent-desktop";

/** True when the command only reads the screen, so no lock is needed. */
export const isReadOnly = (driver: DesktopDriver, args: readonly string[]): boolean => {
  const sub = args.find((a) => !a.startsWith("-"));
  if (!sub) return args.length === 0 || args.every((a) => /^(-h|--help|-V|--version)$/.test(a));
  return READ_ONLY[driver].has(sub);
};

/**
 * Whether `desktop.ts` lets go of every modifier key after the command.
 *
 * The gap: a Shift posted by one helper and an agent-desktop `press cmd+a`
 * left a modifier held, so the bot's next keystrokes fired as shortcuts on the
 * person's Mac - a new Brave window, stray bookmarks, Finder windows. Any
 * action may press keys, so every one ends with `mac-ui.js release-keys`,
 * whichever driver ran it. Reading the screen presses nothing.
 */
export const releasesKeysAfter = (driver: DesktopDriver, args: readonly string[]): boolean =>
  !isReadOnly(driver, args) && !(driver === "mac-ui" && args[0] === "release-keys");

const live = (lock: DesktopLock | null, now: number, ttlMs: number): lock is DesktopLock =>
  lock !== null && now - lock.last < ttlMs;

/** Take (or keep) the screen for `me`, unless another live session has it. */
export const decideDesktopLock = (
  current: DesktopLock | null,
  me: string,
  action: string,
  now: number,
  ttlMs: number = DESKTOP_LOCK_TTL_MS,
): LockDecision => {
  if (live(current, now, ttlMs) && current.holder !== me) return { kind: "busy", lock: current };
  const since = live(current, now, ttlMs) ? current.since : now;
  return { kind: "take", lock: { holder: me, since, last: now, action } };
};

/** Whether `me` could act now - what a watch waits on. */
export const isDesktopFree = (
  current: DesktopLock | null,
  me: string,
  now: number,
  ttlMs: number = DESKTOP_LOCK_TTL_MS,
): boolean => !live(current, now, ttlMs) || current.holder === me;

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
};

/** What a refused session is told: who has it, and how to wait. */
export const busyMessage = (lock: DesktopLock, now: number, freeCommand: string, ttlMs: number = DESKTOP_LOCK_TTL_MS): string =>
  [
    `desktop busy: session ${lock.holder} is driving the screen (since ${ago(now - lock.since)} ago, last action ${ago(now - lock.last)} ago: ${lock.action})`,
    "do NOT open another window or click anyway - its clicks would land in yours",
    `wait for it: set a watch on \`${freeCommand}\` (exits 0 when the screen is yours), or tell that thread you are waiting`,
    `the lock lapses on its own after ${ago(ttlMs)} with no action`,
  ].join("\n");
