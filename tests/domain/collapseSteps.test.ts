import { describe, expect, test } from "bun:test";
import { collapsedBlocks, collapseSteps, type FinishedStep } from "../../src/domain/collapseSteps.ts";

const step = (title: string, failed = false): FinishedStep => ({ title, failed });

describe("collapseSteps", () => {
  test("a column of steps becomes one line", () => {
    const c = collapseSteps([step("run: ls"), step("run: cat x"), step("run: grep y")]);
    expect(c?.summary).toBe("🔧 3 steps");
    expect(c?.failures).toEqual([]);
  });

  test("failures are kept, because they are the part worth acting on", () => {
    const c = collapseSteps([
      step("run: ls"),
      step("run: gh pr view", true),
      step("run: cat x"),
      step("mcp__notion__fetch", true),
    ]);
    expect(c?.summary).toBe("🔧 4 steps, 2 failed");
    expect(c?.failures).toEqual(["run: gh pr view", "mcp__notion__fetch"]);
  });

  test("one step is left alone - swapping a card for a line is not a tidy-up", () => {
    expect(collapseSteps([step("run: ls")])).toBeUndefined();
    expect(collapseSteps([])).toBeUndefined();
  });

  test("blank titles do not count towards the total", () => {
    expect(collapseSteps([step("run: ls"), step("   "), step("")])).toBeUndefined();
  });

  test("a long failure is clipped rather than pasted whole", () => {
    const c = collapseSteps([step("ok"), step("x".repeat(400), true)]);
    expect(c?.failures[0]?.length).toBeLessThanOrEqual(160);
    expect(c?.failures[0]).toContain("…");
  });
});

describe("collapsedBlocks", () => {
  test("the answer comes first, what it took goes underneath", () => {
    const blocks = collapsedBlocks("here is the answer", {
      summary: "🔧 4 steps, 1 failed",
      failures: ["run: gh pr view"],
    });
    expect(blocks[0]).toEqual({ type: "markdown", text: "here is the answer" });
    expect(blocks[1]?.type).toBe("context");
    const text = JSON.stringify(blocks[1]);
    expect(text).toContain("4 steps, 1 failed");
    expect(text).toContain("run: gh pr view");
  });

  test("an empty body leaves just the summary, rather than an empty block", () => {
    const blocks = collapsedBlocks("  ", { summary: "🔧 2 steps", failures: [] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("context");
  });
});
