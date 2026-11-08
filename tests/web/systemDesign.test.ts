import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEPLOY, LIMITS, RELATIONS, SEQUENCE, TABLES, fmtLimit } from "../../web/src/systemDesign.ts";

const root = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Columns per table, from CREATE TABLE plus every ALTER TABLE ... ADD COLUMN in a source file. */
const columnsIn = (src: string): Map<string, Set<string>> => {
  const out = new Map<string, Set<string>>();
  for (const m of src.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? (\w+) \(([\s\S]*?)\n\s*\);/g)) {
    const cols = new Set(
      m[2]!.split("\n").map((l) => l.trim().split(/\s+/)[0] ?? "").filter((w) => /^[a-z_]+$/.test(w)),
    );
    out.set(m[1]!.replace(/_v2$/, ""), new Set([...(out.get(m[1]!) ?? []), ...cols]));
  }
  for (const m of src.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)) {
    out.get(m[1]!)?.add(m[2]!);
  }
  return out;
};

describe("data model diagram", () => {
  const schema = new Map([
    ...columnsIn(read("src/infrastructure/db/schema.ts")),
    ...columnsIn(read("src/infrastructure/inbox/inboxRepo.ts")),
  ]);

  test("every table and column drawn exists in the schema", () => {
    const missing = TABLES.flatMap((t) => {
      const cols = schema.get(t.name);
      if (!cols) return [`table ${t.name}`];
      return t.cols.filter((c) => !cols.has(c.name)).map((c) => `${t.name}.${c.name}`);
    });
    expect(missing).toEqual([]);
  });

  test("relations join tables that are drawn, and no two tables share a cell", () => {
    const names = new Set(TABLES.map((t) => t.name));
    expect(RELATIONS.filter((r) => !names.has(r.from) || !names.has(r.to))).toEqual([]);
    const cells = TABLES.map((t) => `${t.col},${t.row}`);
    expect(new Set(cells).size).toBe(cells.length);
  });
});

describe("limits table", () => {
  test("every limit matches the constant it cites", async () => {
    const wrong: string[] = [];
    for (const l of LIMITS) {
      const [file, name] = l.source.split(":");
      const mod = (await import(join(root, file!))) as Record<string, unknown>;
      if (mod[name!] !== l.value) wrong.push(`${l.source} is ${String(mod[name!])}, page says ${l.value}`);
    }
    expect(wrong).toEqual([]);
  });

  test("formats durations and sizes for people", () => {
    expect(fmtLimit({ label: "", value: 2_500, unit: "ms", source: "", why: "" })).toBe("2.5s");
    expect(fmtLimit({ label: "", value: 15 * 60_000, unit: "ms", source: "", why: "" })).toBe("15 min");
    expect(fmtLimit({ label: "", value: 6 * 3_600_000, unit: "ms", source: "", why: "" })).toBe("6 h");
    expect(fmtLimit({ label: "", value: 11_000, unit: "chars", source: "", why: "" })).toBe("11,000 chars");
  });
});

describe("sequence and deployment diagrams", () => {
  test("every message runs between declared participants", () => {
    const ids = new Set(SEQUENCE.participants.map((p) => p.id));
    expect(ids.size).toBe(SEQUENCE.participants.length);
    expect(SEQUENCE.messages.filter((m) => !ids.has(m.from) || !ids.has(m.to))).toEqual([]);
  });

  test("every deployment link joins boxes that exist, and boxes stay on the canvas", () => {
    const ids = new Set(DEPLOY.boxes.map((b) => b.id));
    expect(DEPLOY.links.filter((l) => !ids.has(l.from) || !ids.has(l.to))).toEqual([]);
    for (const b of DEPLOY.boxes) {
      expect(b.x + b.w).toBeLessThanOrEqual(DEPLOY.w);
      expect(b.y + b.h).toBeLessThanOrEqual(DEPLOY.h);
    }
  });

  test("no deployment link is drawn through a box it does not join", () => {
    const by = new Map(DEPLOY.boxes.map((b) => [b.id, b]));
    const centre = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
    const crossings: string[] = [];
    for (const l of DEPLOY.links) {
      const a = centre(by.get(l.from)!);
      const b = centre(by.get(l.to)!);
      for (const box of DEPLOY.boxes) {
        if (box.kind === "zone" || box.id === l.from || box.id === l.to) continue;
        for (let i = 1; i < 100; i++) {
          const x = a.x + ((b.x - a.x) * i) / 100;
          const y = a.y + ((b.y - a.y) * i) / 100;
          if (x > box.x - 2 && x < box.x + box.w + 2 && y > box.y - 2 && y < box.y + box.h + 2) {
            crossings.push(`${l.from}>${l.to} through ${box.id}`);
            break;
          }
        }
      }
    }
    expect(crossings).toEqual([]);
  });
});
