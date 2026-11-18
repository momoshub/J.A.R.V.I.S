import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalsPath, cachedTools, createFileApprovalStore, createMcpToolsPort, knownServers } from "../../src/infrastructure/mcp/approvals.ts";
import { createFileSchemaCache, schemaCachePath } from "../../src/infrastructure/mcp/lazyProxy.ts";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "mcp-appr-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cache = (server: string, names: string[], command = ["x"]) =>
  createFileSchemaCache(schemaCachePath(dir, server, command)).write({ initialize: { protocolVersion: "1" }, tools: names.map((name) => ({ name })) });

describe("file approval store", () => {
  test("is empty until created, creates once, and writes over", () => {
    const store = createFileApprovalStore(approvalsPath(dir, "pg"));
    expect(store.read()).toBeUndefined();
    expect(store.create({ approved: ["a"], denied: [] })).toBe(true);
    expect(store.create({ approved: ["a", "b"], denied: [] })).toBe(false);
    expect(store.read()).toEqual({ approved: ["a"], denied: [] });
    store.write({ approved: ["a", "b"], denied: ["c"] });
    expect(store.read()).toEqual({ approved: ["a", "b"], denied: ["c"] });
    expect(statSync(approvalsPath(dir, "pg")).mode & 0o777).toBe(0o600);
  });

  test("a damaged file approves nothing instead of everything", () => {
    mkdirSync(join(dir, "approvals"));
    writeFileSync(approvalsPath(dir, "pg"), "{not json");
    expect(createFileApprovalStore(approvalsPath(dir, "pg")).read()).toEqual({ approved: [], denied: [] });
  });

  test("a server name cannot climb out of the directory", () => {
    expect(approvalsPath(dir, "../../etc/x")).toBe(join(dir, "approvals", ".._.._etc_x.json"));
  });
});

describe("cache lookups", () => {
  test("known servers come from cache files and approval files", () => {
    cache("pg-prod", ["a"]);
    createFileApprovalStore(approvalsPath(dir, "dd")).write({ approved: [], denied: [] });
    expect(knownServers(dir)).toEqual(["dd", "pg-prod"]);
    expect(knownServers(join(dir, "missing"))).toEqual([]);
  });

  test("the tools of a server are the ones in its cache", () => {
    cache("pg", ["a", "b"]);
    expect(cachedTools(dir, "pg")?.length).toBe(2);
    expect(cachedTools(dir, "other")).toBeUndefined();
  });
});

describe("McpToolsPort", () => {
  test("a server never baselined has nothing pending; a new tool after the baseline is", () => {
    cache("pg", ["a", "b"]);
    const port = createMcpToolsPort(dir);
    expect(port.status("pg")).toMatchObject({ baselined: false, pending: [] });
    createFileApprovalStore(approvalsPath(dir, "pg")).write({ approved: ["a", "b"], denied: [] });
    cache("pg", ["a", "b", "c"]);
    expect(port.status("pg")).toMatchObject({ baselined: true, pending: ["c"] });
  });

  test("approve and deny move a tool between the lists", () => {
    cache("pg", ["a", "c"]);
    createFileApprovalStore(approvalsPath(dir, "pg")).write({ approved: ["a"], denied: [] });
    const port = createMcpToolsPort(dir);
    expect(port.approve("pg", "c")).toBeUndefined();
    expect(port.status("pg")).toMatchObject({ approved: ["a", "c"], pending: [] });
    expect(port.deny("pg", "a")).toBeUndefined();
    expect(port.status("pg")).toMatchObject({ approved: ["c"], denied: ["a"], pending: [] });
  });

  test("an unknown server or tool is refused", () => {
    cache("pg", ["a"]);
    const port = createMcpToolsPort(dir);
    expect(port.approve("nope", "a")).toContain("unknown server");
    expect(port.approve("pg", "typo")).toContain("does not list");
  });
});
