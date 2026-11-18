import { describe, expect, test } from "bun:test";
import { dispatchCommand } from "../../src/application/commands.ts";
import type { McpToolsPort, ServerApprovals } from "../../src/infrastructure/mcp/approvals.ts";
import { actor, build } from "./commandsFixture.ts";

const setup = () => {
  const state: Record<string, ServerApprovals> = {
    pg: { server: "pg", baselined: true, approved: ["run_query"], denied: [], pending: ["drop_table"] },
    dd: { server: "dd", baselined: true, approved: ["search_logs"], denied: [], pending: [] },
  };
  const calls: string[] = [];
  const port: McpToolsPort = {
    servers: () => Object.keys(state),
    status: (s) => state[s]!,
    approve: (s, t) => (t === "typo" ? "`pg` does not list a tool `typo`" : void calls.push(`approve ${s} ${t}`)),
    deny: (s, t) => void calls.push(`deny ${s} ${t}`),
  };
  const deps = build();
  deps.mcpTools = port;
  const run = (line: string, who = actor(), opts?: Parameters<typeof dispatchCommand>[4]) =>
    dispatchCommand(deps, who, "D0SRC", `mcp-tools ${line}`.trim(), opts);
  return { run, calls, deps };
};

describe("mcp-tools command", () => {
  test("pending lists what waits, by server, and a bare command is pending", async () => {
    const { run } = setup();
    const out = await run("pending");
    expect(out).toContain("*pg*: `drop_table`");
    expect(out).not.toContain("*dd*");
    expect(await run("")).toBe(out);
  });

  test("list shows approved, waiting and denied for one server", async () => {
    const { run } = setup();
    const out = await run("list pg");
    expect(out).toContain("Approved: `run_query`");
    expect(out).toContain("Waiting: `drop_table`");
    expect(await run("list nope")).toContain("I know no MCP server");
  });

  test("approve and deny go through the port; a refusal is reported and changes nothing", async () => {
    const { run, calls } = setup();
    expect(await run("approve pg drop_table")).toContain("Approved `drop_table` of `pg`");
    expect(await run("deny pg run_query")).toContain("Denied");
    expect(await run("approve pg typo")).toContain("Not changed");
    expect(await run("approve pg")).toContain("Name the server and the tool");
    expect(calls).toEqual(["approve pg drop_table", "deny pg run_query"]);
  });

  test("only the owner, and never a turn", async () => {
    const { run, calls } = setup();
    expect(await run("approve pg drop_table", actor({ role: "admin", slackId: "U0ADMIN0001" }))).not.toContain("Approved");
    expect(await run("approve pg drop_table", actor(), { fromBrainRun: true })).toContain("Type the");
    expect(calls).toEqual([]);
  });

  test("help, an unknown word, and a host without the store", async () => {
    const { run, deps } = setup();
    expect(await run("help")).toContain("Discovery is not exposure");
    expect(await run("frob")).toContain("I do not know");
    deps.mcpTools = undefined;
    expect(await run("pending")).toContain("not available");
  });
});
