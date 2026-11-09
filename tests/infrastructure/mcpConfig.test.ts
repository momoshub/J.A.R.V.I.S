import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UNAUTHENTICATED_MCP_SERVERS,
  createClaudeJsonReader,
  mcpConfigFor,
} from "../../src/infrastructure/llm/mcpConfig.ts";

const servers = (json: string | undefined): string[] =>
  Object.keys((JSON.parse(json ?? "{}") as { mcpServers: object }).mcpServers);

describe("mcpConfigFor", () => {
  const host = {
    mcpServers: { figma: {}, datadog: {}, notion: {}, "pg-prod": {}, "clickhouse-sql-us-prod-ro": {}, later: {} },
    projects: { "/repo": { mcpServers: { playwright: {}, figma: {} } }, "/other": { mcpServers: { nope: {} } } },
  };

  test("denies figma and datadog, keeps everything else including a server added later", () => {
    expect(UNAUTHENTICATED_MCP_SERVERS).toEqual(["figma", "datadog"]);
    expect(servers(mcpConfigFor(host, undefined))).toEqual(["notion", "pg-prod", "clickhouse-sql-us-prod-ro", "later"]);
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

describe("createClaudeJsonReader", () => {
  test("reads the file, follows changes, and answers undefined when it is missing or broken", () => {
    const dir = mkdtempSync(join(tmpdir(), "ev-mcp-"));
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
