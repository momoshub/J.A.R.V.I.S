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

  test("the theme is resolved before paint by a file index.html loads, with the same key", () => {
    const web = join(import.meta.dir, "..", "..", "web");
    const init = readFileSync(join(web, "public", "theme-init.js"), "utf8");
    expect(init).toContain(`localStorage.getItem("${THEME_KEY}")`);
    expect(init).toContain("dataset.theme");
    const html = readFileSync(join(web, "index.html"), "utf8");
    expect(html).toContain('<script src="/theme-init.js"></script>');
    // The dashboard's CSP is script-src 'self': an inline script would never run.
    expect(html.match(/<script>(?![\s\S]*?<\/script>\s*$)/)).toBeNull();
    expect(/<script>[\s\S]*?<\/script>/.test(html)).toBe(false);
  });
});
