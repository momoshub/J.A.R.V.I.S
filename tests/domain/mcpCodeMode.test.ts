import { describe, expect, test } from "bun:test";
import {
  MCP_ACCESS_ENV,
  MCP_DENY_ENV,
  headOf,
  mcpCallRefusal,
  parseFields,
  payloadOf,
  projectFields,
  rowCountOf,
  searchTools,
  turnMcpEnv,
} from "../../src/domain/mcpCodeMode.ts";

describe("projectFields", () => {
  const value = {
    total: 2,
    rows: [
      { id: 1, name: "a", meta: { owner: "x", tags: ["t"] }, big: "z".repeat(50) },
      { id: 2, name: "b", meta: { owner: "y", tags: [] }, big: "z" },
    ],
  };

  test("keeps dotted paths, walking through arrays", () => {
    expect(projectFields(value, ["total", "rows.name", "rows.meta.owner"])).toEqual({
      total: 2,
      rows: [{ name: "a", meta: { owner: "x" } }, { name: "b", meta: { owner: "y" } }],
    });
  });

  test("a path that ends at an object keeps all of it; paths that match nothing are dropped", () => {
    expect(projectFields(value, ["rows.meta", "nope", "rows.nope.deeper"])).toEqual({
      rows: [{ meta: { owner: "x", tags: ["t"] } }, { meta: { owner: "y", tags: [] } }],
    });
  });

  test("a top-level array and a scalar", () => {
    expect(projectFields([{ a: 1, b: 2 }], ["a"])).toEqual([{ a: 1 }]);
    expect(projectFields("text", ["a"])).toBe("text");
    expect(projectFields(value, [])).toBe(value);
  });

  test("parses a comma list", () => {
    expect(parseFields(" a, b.c ,,")).toEqual(["a", "b.c"]);
  });
});

describe("payloadOf", () => {
  test("text blocks that hold JSON are parsed", () => {
    expect(payloadOf({ content: [{ type: "text", text: '{"rows":[1,2]}' }] })).toEqual({ kind: "json", value: { rows: [1, 2] } });
  });
  test("structuredContent wins", () => {
    expect(payloadOf({ content: [{ type: "text", text: "x" }], structuredContent: { a: 1 } })).toEqual({ kind: "json", value: { a: 1 } });
  });
  test("plain text stays text; an image keeps the raw result", () => {
    expect(payloadOf({ content: [{ type: "text", text: "hello" }] })).toEqual({ kind: "text", text: "hello" });
    const raw = { content: [{ type: "image", data: "abc" }] };
    expect(payloadOf(raw)).toEqual({ kind: "raw", value: raw });
  });
});

describe("summary helpers", () => {
  test("row counts: a list, or the longest list one level down", () => {
    expect(rowCountOf([1, 2, 3])).toEqual({ rows: 3 });
    expect(rowCountOf({ small: [1], rows: [1, 2, 3] })).toEqual({ rows: 3, where: "rows" });
    expect(rowCountOf({ a: 1 })).toBeUndefined();
  });
  test("head shows the first rows on one line and cuts long output", () => {
    expect(headOf({ kind: "json", value: [1, 2, 3, 4, 5] })).toBe("[1,2,3]");
    expect(headOf({ kind: "text", text: "x".repeat(700) }, 10)).toBe("xxxxxxxxxx...");
  });
});

describe("searchTools", () => {
  const index = [
    { server: "pg", tool: { name: "run_query", description: "Run a SQL query" } },
    { server: "dd", tool: { name: "search_logs", description: "Search Datadog logs by query" } },
    { server: "dd", tool: { name: "list_monitors", description: "monitors" } },
  ];
  test("every word must match; a name match ranks above a description match", () => {
    expect(searchTools(index, "query").map((h) => h.tool.name)).toEqual(["run_query", "search_logs"]);
    expect(searchTools(index, "datadog logs").map((h) => h.tool.name)).toEqual(["search_logs"]);
    expect(searchTools(index, "nothing")).toEqual([]);
    expect(searchTools(index, "  ")).toEqual([]);
  });
});

describe("a call is held to the turn's role", () => {
  test("outside a turn (the owner at a terminal) it is allowed", () => {
    expect(mcpCallRefusal({}, "pg", "run_query")).toBeUndefined();
  });

  test("a sandboxed turn is refused whatever the server", () => {
    const env = turnMcpEnv({ skipPermissions: false, disallowedTools: ["mcp__pg"] });
    expect(env[MCP_ACCESS_ENV]).toBe("sandbox");
    expect(mcpCallRefusal(env, "other", "t")).toContain("no full access");
  });

  test("a full-access turn is refused a server or tool in its disallowed tools, and only that", () => {
    const env = turnMcpEnv({ skipPermissions: true, disallowedTools: ["Bash(aws logs:*)", "mcp__pg-prod", "mcp__datadog__create_monitor"] });
    expect(JSON.parse(env[MCP_DENY_ENV]!)).toEqual(["mcp__pg-prod", "mcp__datadog__create_monitor"]);
    expect(mcpCallRefusal(env, "pg-prod", "run_query")).toContain("may not use");
    expect(mcpCallRefusal(env, "datadog", "create_monitor")).toContain("may not call");
    expect(mcpCallRefusal(env, "datadog", "search_logs")).toBeUndefined();
    expect(mcpCallRefusal(env, "ch", "run_query")).toBeUndefined();
  });

  test("a deny list that cannot be read refuses", () => {
    expect(mcpCallRefusal({ [MCP_ACCESS_ENV]: "full", [MCP_DENY_ENV]: "{" }, "a", "b")).toContain("unreadable");
  });
});
