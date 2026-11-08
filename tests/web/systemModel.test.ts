import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CANVAS, EDGES, FLOWS, NODE, NODES, checkModel, wireCollisions } from "../../web/src/systemModel.ts";

const root = join(import.meta.dir, "..", "..");

describe("architecture page model", () => {
  test("every flow walks wires and boxes that exist", () => {
    expect(checkModel()).toEqual([]);
  });

  test("checkModel catches a flow pointing at nothing", () => {
    const flows = [{ id: "x", title: "", blurb: "", steps: [{ from: "slack", to: "db", note: "" }, { at: "ghost", note: "" }] }];
    expect(checkModel(NODES, EDGES, flows)).toEqual(["x step 1: no wire slack>db", "x step 2: unknown node ghost"]);
  });

  test("every source path a box names is real, so a rename cannot leave the page stale", () => {
    const missing = NODES.flatMap((n) => n.files).filter((f) => !existsSync(join(root, f)));
    expect(missing).toEqual([]);
  });

  test("every box sits fully on the canvas", () => {
    for (const n of NODES) {
      expect(n.x - NODE.w / 2).toBeGreaterThanOrEqual(0);
      expect(n.x + NODE.w / 2).toBeLessThanOrEqual(CANVAS.w);
      expect(n.y - NODE.h / 2).toBeGreaterThanOrEqual(0);
      expect(n.y + NODE.h / 2).toBeLessThanOrEqual(CANVAS.h);
    }
  });

  test("every wire is used by a flow, so the diagram shows nothing unexplained", () => {
    const used = new Set(FLOWS.flatMap((f) => f.steps.flatMap((s) => ("at" in s ? [] : [`${s.from}>${s.to}`]))));
    expect(EDGES.map((e) => `${e.from}>${e.to}`).filter((k) => !used.has(k))).toEqual([]);
  });
});

describe("architecture diagram layout", () => {
  test("no wire runs through a box it does not connect", () => {
    expect(wireCollisions()).toEqual([]);
  });

  test("wireCollisions sees a wire drawn straight through a box", () => {
    const nodes = [
      { ...NODES[0]!, id: "a", x: 100, y: 100 },
      { ...NODES[0]!, id: "mid", x: 400, y: 100 },
      { ...NODES[0]!, id: "b", x: 700, y: 100 },
    ];
    expect(wireCollisions(nodes, [{ from: "a", to: "b", label: "", bend: 0 }])).toEqual(["a>b through mid"]);
    expect(wireCollisions(nodes, [{ from: "a", to: "b", label: "", bend: 160 }])).toEqual([]);
  });
});
