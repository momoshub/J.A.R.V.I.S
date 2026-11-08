import { describe, expect, test } from "bun:test";
import {
  DESKTOP_LOCK_TTL_MS,
  busyMessage,
  decideDesktopLock,
  isDesktopFree,
  isReadOnly,
  releasesKeysAfter,
} from "../../src/domain/desktopLock.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const held = { holder: "s1", since: 1_000, last: 2_000, action: "agent-desktop click @e3" };

describe("decideDesktopLock", () => {
  test("an empty screen is taken", () => {
    expect(decideDesktopLock(null, "s1", "click", 5_000)).toEqual({
      kind: "take",
      lock: { holder: "s1", since: 5_000, last: 5_000, action: "click" },
    });
  });

  test("a second session is refused while the first is driving", () => {
    // the incident: s2 opened its own Brave window while s1 was mid-job
    const d = decideDesktopLock(held, "s2", "agent-desktop launch Brave", 3_000);
    expect(d).toEqual({ kind: "busy", lock: held });
  });

  test("the holder keeps it, and its start time", () => {
    const d = decideDesktopLock(held, "s1", "type", 3_000);
    expect(d).toEqual({ kind: "take", lock: { holder: "s1", since: 1_000, last: 3_000, action: "type" } });
  });

  test("an idle lock lapses, so a dead turn cannot hold the screen forever", () => {
    const later = held.last + DESKTOP_LOCK_TTL_MS;
    expect(decideDesktopLock(held, "s2", "click", later - 1).kind).toBe("busy");
    expect(decideDesktopLock(held, "s2", "click", later)).toEqual({
      kind: "take",
      lock: { holder: "s2", since: later, last: later, action: "click" },
    });
  });
});

describe("isDesktopFree", () => {
  test("free for the holder and on an empty or stale lock, not for anyone else", () => {
    expect(isDesktopFree(null, "s2", 3_000)).toBe(true);
    expect(isDesktopFree(held, "s1", 3_000)).toBe(true);
    expect(isDesktopFree(held, "s2", 3_000)).toBe(false);
    expect(isDesktopFree(held, "s2", held.last + DESKTOP_LOCK_TTL_MS)).toBe(true);
  });
});

describe("isReadOnly", () => {
  test("looking at the screen needs no lock", () => {
    expect(isReadOnly("agent-desktop", ["snapshot", "--app", "Brave Browser", "-i"])).toBe(true);
    expect(isReadOnly("agent-desktop", ["screenshot", "--app", "Brave Browser"])).toBe(true);
    expect(isReadOnly("agent-desktop", ["--help"])).toBe(true);
    expect(isReadOnly("mac-ui", ["tree", "Brave Browser"])).toBe(true);
  });

  test("anything that clicks, types, opens or moves a window does", () => {
    for (const a of [["click", "@e3"], ["type", "@e1", "hi"], ["press", "cmd+n"], ["launch", "Brave Browser"], ["focus-window"]]) {
      expect(isReadOnly("agent-desktop", a)).toBe(false);
    }
    expect(isReadOnly("mac-ui", ["click", "Brave Browser", "Save"])).toBe(false);
    expect(isReadOnly("mac-ui", ["key", "Brave Browser", "return"])).toBe(false);
  });
});

describe("busyMessage", () => {
  test("names the holder, forbids another window, and says how to wait", () => {
    const m = busyMessage(held, 62_000, "/x/desktop.ts free");
    expect(m).toContain("session s1 is driving the screen");
    expect(m).toContain("agent-desktop click @e3");
    expect(m).toContain("do NOT open another window");
    expect(m).toContain("/x/desktop.ts free");
  });
});

describe("modifier keys never stay held", () => {
  test("every action ends by releasing the modifiers, whichever driver ran it", () => {
    expect(releasesKeysAfter("agent-desktop", ["press", "cmd+a"])).toBe(true);
    expect(releasesKeysAfter("agent-desktop", ["type", "@e3", "a+b"])).toBe(true);
    expect(releasesKeysAfter("mac-ui", ["key", "Brave Browser", "return", "--shift"])).toBe(true);
  });

  test("reading the screen, or the release itself, does not", () => {
    expect(releasesKeysAfter("agent-desktop", ["snapshot", "--app", "Brave Browser", "-i"])).toBe(false);
    expect(releasesKeysAfter("mac-ui", ["tree", "Brave Browser"])).toBe(false);
    expect(releasesKeysAfter("mac-ui", ["release-keys"])).toBe(false);
  });

  test("mac-ui.js sets flags on every key event from a private source and releases in a finally", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "bin", "mac-ui.js"), "utf8");
    // one place builds key events, and it always sets the flags, even none
    expect(src.match(/CGEventCreateKeyboardEvent\(/g)?.length).toBe(1);
    expect(src).toContain("CGEventCreateKeyboardEvent(src, code, isDown);\n  $.CGEventSetFlags(ev, flagsMask);");
    expect(src).toContain("kCGEventSourceStatePrivate");
    expect(src).toMatch(/finally \{\s*releaseModifiers\(\);/);
    expect(src).toContain("cmd === 'release-keys'");
  });
});
