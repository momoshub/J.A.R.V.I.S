import { describe, expect, test } from "bun:test";
import {
  approveTool,
  baselineOf,
  denyTool,
  exposedTools,
  isApproved,
  parseApprovalState,
  pendingOf,
  toolNameOf,
} from "../../src/domain/mcpApproval.ts";

const tools = (...names: string[]) => names.map((name) => ({ name, description: `does ${name}` }));

describe("mcp tool approval", () => {
  test("the first run's tools are the baseline", () => {
    const s = baselineOf(tools("b", "a", "a"));
    expect(s).toEqual({ approved: ["a", "b"], denied: [] });
    expect(pendingOf(s, tools("a", "b"))).toEqual([]);
  });

  test("a tool listed later is pending, hidden from the list, and not approved", () => {
    const s = baselineOf(tools("a"));
    const listed = tools("a", "new_tool");
    expect(pendingOf(s, listed)).toEqual(["new_tool"]);
    expect(exposedTools(s, listed)).toEqual(tools("a"));
    expect(isApproved(s, "new_tool")).toBe(false);
  });

  test("approve exposes it; a changed description is still the same tool", () => {
    const s = approveTool(baselineOf(tools("a")), "new_tool");
    expect(exposedTools(s, [{ name: "new_tool", description: "now does more" }, ...tools("a")])).toHaveLength(2);
  });

  test("deny hides a tool, takes it off the pending list, and revokes an approved one", () => {
    const s = denyTool(baselineOf(tools("a", "b")), "b");
    expect(isApproved(s, "b")).toBe(false);
    expect(pendingOf(s, tools("a", "b", "c"))).toEqual(["c"]);
    expect(isApproved(approveTool(s, "b"), "b")).toBe(true);
    expect(approveTool(s, "b").denied).toEqual([]);
  });

  test("a removed tool simply drops out of what is exposed", () => {
    const s = baselineOf(tools("a", "b"));
    expect(exposedTools(s, tools("a"))).toEqual(tools("a"));
  });

  test("a malformed stored state approves nothing", () => {
    expect(parseApprovalState("garbage")).toEqual({ approved: [], denied: [] });
    expect(parseApprovalState({ approved: ["x", 3, null], denied: "no" })).toEqual({ approved: ["x"], denied: [] });
  });

  test("items without a name are never exposed", () => {
    expect(toolNameOf({ description: "x" })).toBeUndefined();
    expect(exposedTools(baselineOf(tools("a")), [{ description: "x" }, "a"])).toEqual([]);
  });
});
