import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THEME_KEY, nextTheme, readTheme, resolveTheme, writeTheme } from "../../web/src/ui/theme.ts";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("theme preference", () => {
  test("defaults to the system, and ignores junk or a broken store", () => {
    expect(readTheme(undefined)).toBe("system");
    const s = memory();
    s.setItem(THEME_KEY, "purple");
    expect(readTheme(s)).toBe("system");
    expect(readTheme({ getItem: () => { throw new Error("denied"); }, setItem: () => {} })).toBe("system");
    expect(() => writeTheme({ getItem: () => null, setItem: () => { throw new Error("quota"); } }, "dark")).not.toThrow();
  });

  test("remembers a choice", () => {
    const s = memory();
    writeTheme(s, "dark");
    expect(readTheme(s)).toBe("dark");
  });

  test("resolves system from the OS, and a forced choice regardless of it", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("cycles system -> light -> dark -> system", () => {
    expect(nextTheme("system")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
  });

  test("index.html resolves the theme before paint with the same storage key", () => {
    const html = readFileSync(join(import.meta.dir, "..", "..", "web", "index.html"), "utf8");
    expect(html).toContain(`localStorage.getItem("${THEME_KEY}")`);
    expect(html).toContain("dataset.theme");
  });
});
