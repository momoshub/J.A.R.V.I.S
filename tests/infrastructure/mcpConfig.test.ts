import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UNAUTHENTICATED_MCP_SERVERS,
  createClaudeJsonReader,
  mcpConfigFor, unknownMcpServers, unlistedLocalMcpServers } from "../../src/infrastructure/llm/mcpConfig.ts";

const servers = (json: string | undefined): string[] =>
  Object.keys((JSON.parse(json ?? "{}") as { mcpServers: object }).mcpServers);

describe("mcpConfigFor", () => {
  const host = {
    mcpServers: { figma: {}, datadog: {}, notion: {}, "acme-pg-prod": {}, "clickhouse-sql-us-prod-ro": {}, later: {} },
    projects: { "/repo": { mcpServers: { playwright: {}, figma: {} } }, "/other": { mcpServers: { nope: {} } } },
  };

  test("denies figma and datadog, keeps everything else including a server added later", () => {
    expect(UNAUTHENTICATED_MCP_SERVERS).toEqual(["figma", "datadog"]);
    expect(servers(mcpConfigFor(host, undefined))).toEqual(["notion", "acme-pg-prod", "clickhouse-sql-us-prod-ro", "later"]);
  });

  test("adds the project servers for the spawn's cwd only, and the denylist covers them too", () => {
    expect(servers(mcpConfigFor(host, "/repo"))).toContain("playwright");
    expect(servers(mcpConfigFor(host, "/repo"))).not.toContain("figma");
    expect(servers(mcpConfigFor(host, "/repo"))).not.toContain("nope");
  });

  test("keeps each server's definition untouched", () => {
    const cfg = JSON.parse(mcpConfigFor({ mcpServers: { a: { command: "x", args: ["1"] } } }, undefined)!);
    expect(cfg).toEqual({ mcpServers: { a: { command: "x", args: ["1"] } } });
  });

  test("no usable server list gives undefined, so the caller does not load nothing", () => {
    expect(mcpConfigFor(undefined, undefined)).toBeUndefined();
    expect(mcpConfigFor([], undefined)).toBeUndefined();
    expect(mcpConfigFor({ projects: {} }, undefined)).toBeUndefined();
  });
});

describe("mcpConfigFor lazy proxy", () => {
  const lazy = { runtime: "/bin/bun", script: "/repo/bin/mcp-lazy-proxy.ts", cacheDir: "/cache" };
  const host = {
    mcpServers: {
      "pg-prod": { type: "stdio", command: "/bin/bunx", args: ["dbhub", "--x"], env: { DSN: "secret" } },
      bare: { command: "tool" },
      notion: { type: "http", url: "https://example.test/mcp" },
      "ch-prod": { command: "uvx", args: ["mcp-clickhouse"] },
    },
  };
  const parsed = (json: string | undefined) => (JSON.parse(json ?? "{}") as { mcpServers: Record<string, any> }).mcpServers;

  test("wraps every stdio server in the proxy, keeping its env, and leaves http alone", () => {
    const cfg = parsed(mcpConfigFor(host, undefined, [], { lazy }));
    expect(cfg["pg-prod"]).toEqual({
      type: "stdio",
      command: "/bin/bun",
      args: ["--no-env-file", "/repo/bin/mcp-lazy-proxy.ts", "--name", "pg-prod", "--cache-dir", "/cache", "--", "/bin/bunx", "dbhub", "--x"],
      env: { DSN: "secret" },
    });
    expect(cfg.bare.args).toEqual(["--no-env-file", "/repo/bin/mcp-lazy-proxy.ts", "--name", "bare", "--cache-dir", "/cache", "--", "tool"]);
    expect(cfg.notion).toEqual({ type: "http", url: "https://example.test/mcp" });
  });

  test("a server named whole in disallowedTools is not in the config at all; a single tool deny keeps it", () => {
    const cfg = parsed(mcpConfigFor(host, undefined, [], { lazy, disallowedTools: ["Bash", "mcp__pg-prod", "mcp__notion", "mcp__ch-prod__run_query"] }));
    expect(Object.keys(cfg)).toEqual(["bare", "ch-prod"]);
  });

  test("without the option nothing is wrapped", () => {
    expect(parsed(mcpConfigFor(host, undefined, []))["pg-prod"].command).toBe("/bin/bunx");
  });
});

describe("createClaudeJsonReader", () => {
  test("reads the file, follows changes, and answers undefined when it is missing or broken", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-mcp-"));
    const path = join(dir, "c.json");
    const read = createClaudeJsonReader(path);
    expect(read()).toBeUndefined();
    writeFileSync(path, JSON.stringify({ mcpServers: { a: {} } }));
    expect(read()).toEqual({ mcpServers: { a: {} } });
    writeFileSync(path, JSON.stringify({ mcpServers: { a: {}, b: {} } }));
    expect(read()).toEqual({ mcpServers: { a: {}, b: {} } });
    writeFileSync(path, "{not json");
    expect(read()).toBeUndefined();
  });
});

describe("unlistedLocalMcpServers", () => {
  const json = {
    mcpServers: {
      "pg-prod": { command: "dbhub" },
      "ch-ro": { type: "stdio", command: "uvx" },
      notion: { type: "http", url: "https://example.com/mcp" },
    },
  };

  test("names local stdio servers the database list does not cover", () => {
    expect(unlistedLocalMcpServers(json, [])).toEqual(["pg-prod", "ch-ro"]);
    expect(unlistedLocalMcpServers(json, ["pg-prod"])).toEqual(["ch-ro"]);
    expect(unlistedLocalMcpServers(json, ["mcp__pg-prod", " ch-ro "])).toEqual([]);
  });

  test("an unreadable or empty config names nothing", () => {
    expect(unlistedLocalMcpServers(undefined, [])).toEqual([]);
    expect(unlistedLocalMcpServers({}, [])).toEqual([]);
  });
});

describe("unknownMcpServers", () => {
  const json = { mcpServers: { "pg-prod": { command: "dbhub" }, notion: { type: "http", url: "https://example.com/mcp" } } };

  test("names the entries that match no user-scope server, so a typo is not silent", () => {
    expect(unknownMcpServers(json, ["pg-prod", "pg-prd", "notion"])).toEqual(["pg-prd"]);
    expect(unknownMcpServers(json, [])).toEqual([]);
    // a prototype name is not a server
    expect(unknownMcpServers(json, ["toString"])).toEqual(["toString"]);
  });

  test("an unreadable or empty config says nothing, since nothing can be told", () => {
    expect(unknownMcpServers(undefined, ["pg-prod"])).toEqual([]);
    expect(unknownMcpServers({}, ["pg-prod"])).toEqual([]);
  });
});
