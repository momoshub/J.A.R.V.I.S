import { describe, expect, test } from "bun:test";
import { SIDEBAR_KEY, isToggleShortcut, readCollapsed, writeCollapsed } from "../../web/src/ui/sidebarState.ts";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};
const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } };
const key = (over: Partial<Parameters<typeof isToggleShortcut>[0]> = {}) =>
  ({ key: "b", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, target: { tagName: "BODY" }, ...over });

describe("sidebar collapsed state", () => {
  test("starts expanded with nothing stored, or no storage at all", () => {
    expect(readCollapsed(memory())).toBe(false);
    expect(readCollapsed(undefined)).toBe(false);
  });

  test("remembers a toggle both ways", () => {
    const s = memory();
    writeCollapsed(s, true);
    expect(s.m.get(SIDEBAR_KEY)).toBe("1");
    expect(readCollapsed(s)).toBe(true);
    writeCollapsed(s, false);
    expect(readCollapsed(s)).toBe(false);
  });

  test("a storage that throws never takes the page down", () => {
    expect(readCollapsed(broken)).toBe(false);
    expect(() => writeCollapsed(broken, true)).not.toThrow();
  });
});

describe("sidebar shortcut", () => {
  test("Ctrl+B and Cmd+B toggle", () => {
    expect(isToggleShortcut(key())).toBe(true);
    expect(isToggleShortcut(key({ ctrlKey: false, metaKey: true, key: "B" }))).toBe(true);
  });

  test("a plain b, other modifiers, or typing in a field do not", () => {
    expect(isToggleShortcut(key({ ctrlKey: false }))).toBe(false);
    expect(isToggleShortcut(key({ shiftKey: true }))).toBe(false);
    expect(isToggleShortcut(key({ altKey: true }))).toBe(false);
    expect(isToggleShortcut(key({ target: { tagName: "TEXTAREA" } }))).toBe(false);
    expect(isToggleShortcut(key({ target: { tagName: "INPUT" } }))).toBe(false);
    expect(isToggleShortcut(key({ target: { tagName: "DIV", isContentEditable: true } }))).toBe(false);
  });

  test("holding the keys or composing text does not flicker it", () => {
    expect(isToggleShortcut(key({ repeat: true }))).toBe(false);
    expect(isToggleShortcut(key({ isComposing: true }))).toBe(false);
  });
});
