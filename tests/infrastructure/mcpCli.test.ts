import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMcpCli } from "../../src/infrastructure/mcp/codeMode.ts";
import { approvalsPath, createFileApprovalStore } from "../../src/infrastructure/mcp/approvals.ts";
import { MCP_ACCESS_ENV, turnMcpEnv } from "../../src/domain/mcpCodeMode.ts";

const fake = join(import.meta.dir, "fixtures", "fakeDbMcpServer.ts");

let dir: string;
let claudeJson: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-cli-"));
  claudeJson = join(dir, "claude.json");
  writeFileSync(
    claudeJson,
    JSON.stringify({
      mcpServers: {
        pg: { command: process.execPath, args: [fake], env: { FAKE_MCP_SECRET: "from-server-env" } },
        remote: { type: "http", url: "https://example.invalid/mcp" },
      },
    }),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = async (argv: string[], env: Record<string, string | undefined> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMcpCli([...argv, "--claude-json", claudeJson, "--cache-dir", join(dir, "cache"), "--out", join(dir, "out")], {
    env,
    cwd: dir,
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    now: () => new Date("2026-11-18T10:00:00Z"),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
};
const resultFile = (out: string): string => /result: (\S+)/.exec(out)![1]!;

describe("mcp call", () => {
  test("writes the full result to a file and prints only path, size, rows and a head", async () => {
    const r = await run(["call", "pg", "run_query", '{"sql":"select 1"}']);
    expect(r.code).toBe(0);
    const file = resultFile(r.out);
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.sql).toBe("select 1");
    expect(written.rows).toHaveLength(5);
    // the server's own env from the config reached it
    expect(written.rows[0].secret).toBe("from-server-env");
    expect(r.out).toContain("5 rows (rows)");
    expect(r.out).toMatch(/size: \d+ bytes/);
    expect(r.out).toContain("head: ");
    expect(r.out).not.toContain("row5");
  });

  test("--fields keeps only those paths before the file is written", async () => {
    const r = await run(["call", "pg", "run_query", '{"sql":"select 1"}', "--fields", "rows.id,rows.name"]);
    expect(r.code).toBe(0);
    const written = JSON.parse(readFileSync(resultFile(r.out), "utf8"));
    expect(written).toEqual({ rows: [1, 2, 3, 4, 5].map((id) => ({ id, name: `row${id}` })) });
    expect(r.out).toContain("projected to rows.id,rows.name");
  });

  test("a tool that reports an error still leaves its output, and exits non-zero", async () => {
    const r = await run(["call", "pg", "boom"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("the tool reported an error");
    expect(readFileSync(resultFile(r.out), "utf8")).toBe("it broke");
  });

  test("bad arguments, unknown servers and unknown tools are refused without a spawn", async () => {
    expect((await run(["call", "pg", "run_query", "not json"])).err).toContain("one JSON object");
    expect((await run(["call", "nope", "x"])).err).toContain('unknown server "nope"');
    await run(["call", "pg", "run_query", "{}"]);
    expect((await run(["call", "pg", "no_such_tool", "{}"])).err).toContain('lists no tool "no_such_tool"');
  });
});

describe("mcp call respects the turn's role", () => {
  const full = (disallowedTools: string[]) => ({ ...turnMcpEnv({ skipPermissions: true, disallowedTools }) });

  test("a sandboxed turn cannot use it", async () => {
    const r = await run(["call", "pg", "run_query", "{}"], turnMcpEnv({ skipPermissions: false }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("refused");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  test("a server in the turn's disallowed tools is refused, not reachable around --disallowedTools", async () => {
    const r = await run(["call", "pg", "run_query", "{}"], full(["mcp__pg"]));
    expect(r.code).toBe(1);
    expect(r.err).toContain("may not use the `pg` MCP server");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  test("a single disallowed tool is refused and the server's other tools are not", async () => {
    expect((await run(["call", "pg", "drop_table", "{}"], full(["mcp__pg__drop_table"]))).err).toContain("may not call `drop_table`");
    expect((await run(["call", "pg", "run_query", "{}"], full(["mcp__pg__drop_table"]))).code).toBe(0);
  });

  test("outside a turn there is no access marker and the owner's terminal works", async () => {
    expect(MCP_ACCESS_ENV in {}).toBe(false);
    expect((await run(["call", "pg", "run_query", "{}"])).code).toBe(0);
  });
});

describe("mcp call and the owner's tool approval", () => {
  test("a tool the owner has not approved cannot be called, even from the shell", async () => {
    await run(["call", "pg", "run_query", "{}"]); // first run: the baseline
    createFileApprovalStore(approvalsPath(join(dir, "cache"), "pg")).write({ approved: ["run_query"], denied: [] });
    const r = await run(["call", "pg", "drop_table", "{}"]);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain("mcp-tools approve pg drop_table");
    expect((await run(["call", "pg", "run_query", "{}"])).code).toBe(0);
  });
});

describe("mcp list / search / schema (from the cache, no server)", () => {
  test("before any call there is no cache to read", async () => {
    const r = await run(["list"]);
    expect(r.out).toContain("pg  no schema cache yet");
    expect(r.out).toContain("remote  not reachable from the shell");
  });

  test("after a call: tool counts, search and schema, with unapproved tools left out", async () => {
    await run(["call", "pg", "run_query", "{}"]);
    // wait for the background cache refresh the first spawn does
    for (let i = 0; i < 50 && !(await run(["list"])).out.includes("pg  3 tools"); i++) await new Promise((r) => setTimeout(r, 50));
    expect((await run(["list"])).out).toContain("pg  3 tools");
    expect((await run(["search", "sql"])).out).toBe("pg run_query  Run a SQL query and return rows");
    expect((await run(["search", "nothing-like-this"])).code).toBe(1);
    expect(JSON.parse((await run(["schema", "pg", "run_query"])).out)).toMatchObject({ properties: { sql: { type: "string" } } });

    createFileApprovalStore(approvalsPath(join(dir, "cache"), "pg")).write({ approved: ["run_query"], denied: [] });
    expect((await run(["list"])).out).toContain("pg  1 tool  (2 waiting for the owner's approval)");
    expect((await run(["search", "drop"])).code).toBe(1);
    expect((await run(["schema", "pg", "drop_table"])).err).toContain("lists no tool");
  });

  test("help and a missing command", async () => {
    expect((await run(["help"])).out).toContain("mcp call <server> <tool>");
    expect((await run([])).code).toBe(2);
    expect((await run(["frobnicate"])).err).toContain("unknown command");
  });
});
