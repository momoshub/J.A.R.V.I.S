import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createAdapterStore } from "../../src/infrastructure/adapter/adapterStore.ts";

const MANIFEST = "template:\n  id: mem\n  version: \"1.0\"\n  name: Memory\nexports:\n  context: ADAPTER.md\n  skills: skills\n";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  dirs.push(dir);
  return dir;
};

const seed = (files: Record<string, string>): string => {
  const dir = tmp("adapter-legacy");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
};

const legacy = () =>
  seed({
    "adapter.yaml": MANIFEST,
    "ADAPTER.md": "# Policy\n- be clear\n",
    "skills/demo/SKILL.md": "---\nname: demo\ndescription: a demo skill\n---\nbody\n",
  });

describe("the adapter store", () => {
  test("imports the old directory once, into the database", () => {
    const db = openDatabase(":memory:");
    const store = createAdapterStore(db, tmp("mirror"), legacy());
    expect(store.exists()).toBe(true);
    expect(store.load().policy).toContain("be clear");
    const rows = db.query<{ n: number }, []>("SELECT count(*) AS n FROM adapter_files").get();
    expect(rows?.n).toBe(3);
  });

  test("the database wins over the old directory once it has rows", () => {
    const db = openDatabase(":memory:");
    const old = legacy();
    createAdapterStore(db, tmp("mirror"), old);
    writeFileSync(join(old, "ADAPTER.md"), "# Policy\n- something stale\n");
    const again = createAdapterStore(db, tmp("mirror"), old);
    expect(again.load().policy).toContain("be clear");
  });

  test("the mirror is rendered from the rows, and edits to it are overwritten", () => {
    const db = openDatabase(":memory:");
    const mirror = tmp("mirror");
    const store = createAdapterStore(db, mirror, legacy());
    expect(readFileSync(join(mirror, "skills/demo/SKILL.md"), "utf8")).toContain("a demo skill");
    expect(store.load().skills[0]?.path).toBe("skills/demo/SKILL.md");
    expect(store.root).toBe(mirror);

    writeFileSync(join(mirror, "ADAPTER.md"), "# Policy\n- hand edit\n");
    writeFileSync(join(mirror, "stray.md"), "x");
    createAdapterStore(db, mirror);
    expect(readFileSync(join(mirror, "ADAPTER.md"), "utf8")).toContain("be clear");
    expect(existsSync(join(mirror, "stray.md"))).toBe(false);
  });

  test("a write replaces the rows and the mirror, removing what is gone", () => {
    const db = openDatabase(":memory:");
    const mirror = tmp("mirror");
    const store = createAdapterStore(db, mirror, legacy());
    const next = new Map(store.files());
    next.delete("skills/demo/SKILL.md");
    store.write(next);
    expect(store.files().has("skills/demo/SKILL.md")).toBe(false);
    expect(existsSync(join(mirror, "skills/demo"))).toBe(false);
  });

  test("refuses a path that escapes the adapter, without touching the rows", () => {
    const db = openDatabase(":memory:");
    const store = createAdapterStore(db, tmp("mirror"), legacy());
    const next = new Map(store.files()).set("../escape.md", "x");
    expect(() => store.write(next)).toThrow("outside the adapter");
    expect(store.files().has("../escape.md")).toBe(false);
  });

  test("no adapter anywhere means none exists", () => {
    const store = createAdapterStore(openDatabase(":memory:"), tmp("mirror"), tmp("empty"));
    expect(store.exists()).toBe(false);
  });
});
