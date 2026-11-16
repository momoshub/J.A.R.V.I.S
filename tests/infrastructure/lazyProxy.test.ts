import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileSchemaCache,
  createLazyProxy,
  createLineParser,
  schemaCachePath,
  type CachedSchema,
  type JsonRpc,
  type RealServer,
} from "../../src/infrastructure/mcp/lazyProxy.ts";

const INIT: JsonRpc = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "real", version: "1" } };
const TOOLS = [{ name: "run_query" }];

/** A scripted real server: answers initialize/tools/list/tools/call and records what it was sent. */
const harness = (cached?: CachedSchema, opts: { hang?: boolean; startTimeoutMs?: number; tools?: unknown[] } = {}) => {
  const sent: JsonRpc[] = [];
  const out: JsonRpc[] = [];
  let spawned = 0;
  let stored = cached;
  const exits: (() => void)[] = [];
  let exit: () => void = () => {};
  const proxy = createLazyProxy({
    cache: { read: () => stored, write: (s) => void (stored = s) },
    out: (m) => void out.push(m),
    startTimeoutMs: opts.startTimeoutMs,
    spawn: (): RealServer => {
      spawned++;
      let on: (m: JsonRpc) => void = () => {};
      return {
        onMessage: (cb) => void (on = cb),
        onExit: (cb) => void (exits.push(cb), (exit = cb)),
        kill: () => {},
        send: (m) => {
          sent.push(m);
          if (opts.hang) return;
          queueMicrotask(() => {
            if (m.method === "initialize") on({ jsonrpc: "2.0", id: m.id, result: INIT });
            if (m.method === "tools/list") on({ jsonrpc: "2.0", id: m.id, result: { tools: opts.tools ?? TOOLS } });
            if (m.method === "tools/call") on({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "rows" }] } });
          });
        },
      };
    },
  });
  return { proxy, sent, out, spawned: () => spawned, stored: () => stored, exit: () => exit(), exits };
};

const tick = () => new Promise((r) => setTimeout(r, 5));
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cli", version: "1" } } };

describe("createLazyProxy with a warm cache", () => {
  test("answers initialize, ping and tools/list without starting the real server", async () => {
    const h = harness({ initialize: INIT, tools: TOOLS });
    await h.proxy.handle(initialize);
    await h.proxy.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    await h.proxy.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await h.proxy.handle({ jsonrpc: "2.0", id: 3, method: "ping" });
    expect(h.out).toEqual([
      { jsonrpc: "2.0", id: 1, result: INIT },
      { jsonrpc: "2.0", id: 2, result: { tools: TOOLS } },
      { jsonrpc: "2.0", id: 3, result: {} },
    ]);
    expect(h.spawned()).toBe(0);
  });

  test("the first tools/call starts the real server once, replays the handshake, and forwards the call", async () => {
    const h = harness({ initialize: INIT, tools: TOOLS });
    await h.proxy.handle(initialize);
    await h.proxy.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "run_query" } });
    await h.proxy.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "run_query" } });
    await tick();
    expect(h.spawned()).toBe(1);
    // the real server got the client's own initialize params, then the initialized notification
    expect(h.sent[0]).toMatchObject({ method: "initialize", params: initialize.params });
    expect(h.sent[1]).toMatchObject({ method: "notifications/initialized" });
    expect(h.out.filter((m) => m.id === 4 || m.id === 5).map((m) => m.id)).toEqual([4, 5]);
    // the proxy's own handshake answers never reach the client
    expect(h.out.some((m) => String(m.id).startsWith("lazy-proxy"))).toBe(false);
  });

  test("a spawn refreshes the cache with the real tool list", async () => {
    const h = harness({ initialize: INIT, tools: [{ name: "stale" }] });
    await h.proxy.handle(initialize);
    await h.proxy.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {} });
    await tick();
    expect(h.stored()?.tools).toEqual(TOOLS);
  });

  test("a server that dies mid-call fails the pending request instead of hanging it", async () => {
    const h = harness({ initialize: INIT, tools: TOOLS });
    // the scripted server never answers resources/read, so the request is still pending when it exits
    await h.proxy.handle({ jsonrpc: "2.0", id: 8, method: "resources/read", params: { uri: "r://1" } });
    await tick();
    h.exit();
    expect(h.out.find((m) => m.id === 8)).toMatchObject({ error: { message: expect.stringContaining("exited") } });
  });
});

describe("createLazyProxy start and restart", () => {
  test("a real server that never answers initialize is given up on, failing the request instead of hanging", async () => {
    const h = harness({ initialize: INIT, tools: TOOLS }, { hang: true, startTimeoutMs: 20 });
    await h.proxy.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {} });
    expect(h.out).toEqual([{ jsonrpc: "2.0", id: 4, error: { code: -32603, message: expect.stringContaining("did not initialize") } }]);
    expect(h.proxy.state().running).toBe(false);
  });

  test("the next tools/call after the server exited starts it again and succeeds", async () => {
    const h = harness({ initialize: INIT, tools: TOOLS });
    await h.proxy.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
    await tick();
    h.exit();
    await h.proxy.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
    await tick();
    expect(h.spawned()).toBe(2);
    expect(h.out.filter((m) => m.id === 2)).toEqual([{ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "rows" }] } }]);
  });

  test("a late exit of an old server does not tear down the one that replaced it", async () => {
    const h = harness({ initialize: INIT, tools: TOOLS });
    await h.proxy.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
    await tick();
    h.exits[0]!();
    await h.proxy.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
    await tick();
    h.exits[0]!(); // the first server's exit reported again, late
    expect(h.proxy.state().running).toBe(true);
    expect(h.out.some((m) => m.error !== undefined)).toBe(false);
  });

  test("two tools/call on a cold start start the server once and are forwarded in order", async () => {
    const h = harness({ initialize: INIT, tools: TOOLS });
    await Promise.all([
      h.proxy.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }),
      h.proxy.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} }),
    ]);
    await tick();
    expect(h.spawned()).toBe(1);
    expect(h.sent.filter((m) => m.method === "tools/call").map((m) => m.id)).toEqual([1, 2]);
  });

  test("a cancellation sent while the server starts reaches it after initialize and after the request it cancels", async () => {
    const h = harness({ initialize: INIT, tools: TOOLS });
    await h.proxy.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
    await h.proxy.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    await tick();
    const order = h.sent.map((m) => String(m.method ?? m.id));
    expect(order.indexOf("initialize")).toBeLessThan(order.indexOf("tools/call"));
    expect(order.indexOf("tools/call")).toBeLessThan(order.indexOf("notifications/cancelled"));
  });

  test("a cancellation with no server running goes nowhere", async () => {
    const h = harness({ initialize: INIT, tools: TOOLS });
    await h.proxy.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    expect(h.spawned()).toBe(0);
  });

  test("the real server is initialized with the protocol version the cached answer promised", async () => {
    const h = harness({ initialize: { ...INIT, protocolVersion: "2024-11-05" }, tools: TOOLS });
    await h.proxy.handle({ ...initialize, params: { ...initialize.params, protocolVersion: "2026-07-28" } });
    await h.proxy.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
    await tick();
    expect(h.sent[0]).toMatchObject({ method: "initialize", params: { protocolVersion: "2024-11-05" } });
  });

  test("an empty tool list is not cached, so the next turn asks the real server again", async () => {
    const h = harness(undefined, { tools: [] });
    await h.proxy.handle(initialize);
    await tick();
    expect(h.stored()).toBeUndefined();
  });
});

describe("createLazyProxy discovery", () => {
  test("refuses the server/discover probe at once, as a handshake-era server does, without a spawn", async () => {
    const h = harness({ initialize: INIT, tools: TOOLS });
    await h.proxy.handle({ jsonrpc: "2.0", id: "server-discover-probe-1", method: "server/discover", params: {} });
    expect(h.out).toEqual([{ jsonrpc: "2.0", id: "server-discover-probe-1", error: { code: -32600, message: expect.stringContaining("handshake protocol era") } }]);
    expect(h.spawned()).toBe(0);
  });

  test("an unknown method is not found, without a spawn", async () => {
    const h = harness({ initialize: INIT, tools: TOOLS });
    await h.proxy.handle({ jsonrpc: "2.0", id: 9, method: "nope/what" });
    expect(h.out[0]).toMatchObject({ id: 9, error: { code: -32601 } });
    expect(h.spawned()).toBe(0);
  });

  test("prompts and resources lists come from the cache too, so listing them never starts the server", async () => {
    const withLists: CachedSchema = {
      initialize: { ...INIT, capabilities: { tools: {}, prompts: {}, resources: {} } },
      tools: TOOLS,
      lists: { "prompts/list": [{ name: "p" }], "resources/list": [{ uri: "r://1" }], "resources/templates/list": [] },
    };
    const h = harness(withLists);
    for (const [id, method] of [[1, "prompts/list"], [2, "resources/list"], [3, "resources/templates/list"]] as const) {
      await h.proxy.handle({ jsonrpc: "2.0", id, method });
    }
    expect(h.out.map((m) => m.result)).toEqual([{ prompts: [{ name: "p" }] }, { resources: [{ uri: "r://1" }] }, { resourceTemplates: [] }]);
    expect(h.spawned()).toBe(0);
  });

  test("a cold spawn records the lists of the capabilities the server advertises", async () => {
    // the scripted server advertises tools only, so only tools/list is recorded
    const h = harness();
    await h.proxy.handle(initialize);
    await tick();
    expect(h.stored()?.lists).toEqual({});
  });
});

describe("createLazyProxy with a cold cache", () => {
  test("spawns once to answer initialize and tools/list, then writes the cache", async () => {
    const h = harness();
    await h.proxy.handle(initialize);
    await h.proxy.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await tick();
    expect(h.out).toEqual([
      { jsonrpc: "2.0", id: 1, result: INIT },
      { jsonrpc: "2.0", id: 2, result: { tools: TOOLS } },
    ]);
    expect(h.spawned()).toBe(1);
    expect(h.stored()).toEqual({ initialize: INIT, tools: TOOLS, lists: {} });
  });
});

describe("schema cache", () => {
  test("round-trips on disk, and a changed launch line gets its own file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lazy-cache-"));
    const a = schemaCachePath(dir, "pg/prod", ["bunx", "dbhub@1"]);
    expect(a).not.toBe(schemaCachePath(dir, "pg/prod", ["bunx", "dbhub@2"]));
    const cache = createFileSchemaCache(join(dir, "nested", "a.json"));
    expect(cache.read()).toBeUndefined();
    cache.write({ initialize: INIT, tools: TOOLS });
    expect(cache.read()).toEqual({ initialize: INIT, tools: TOOLS });
    // the schema can hold a database's table names: private to this user
    expect(statSync(join(dir, "nested", "a.json")).mode & 0o077).toBe(0);
  });

  test("unreadable cache is a miss, not a crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "lazy-cache-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, "{not json");
    expect(createFileSchemaCache(path).read()).toBeUndefined();
  });
});

describe("createLineParser", () => {
  test("joins split chunks and skips lines that are not JSON objects", () => {
    const got: JsonRpc[] = [];
    const feed = createLineParser((m) => got.push(m));
    feed('{"a":1}\nnot json\n{"b"');
    feed(':2}\n[1]\n');
    expect(got).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("bin/mcp-lazy-proxy.ts end to end", () => {
  const script = join(import.meta.dir, "..", "..", "bin", "mcp-lazy-proxy.ts");
  const fake = join(import.meta.dir, "fixtures", "fakeMcpServer.ts");

  const session = async (cacheDir: string, log: string, requests: JsonRpc[], waitFor: number) => {
    const proc = Bun.spawn({
      cmd: [process.execPath, script, "--name", "fake", "--cache-dir", cacheDir, "--", process.execPath, fake],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FAKE_MCP_LOG: log },
    });
    for (const r of requests) proc.stdin.write(`${JSON.stringify(r)}\n`);
    void proc.stdin.flush();
    const replies: JsonRpc[] = [];
    const parse = createLineParser((m) => replies.push(m));
    const reader = proc.stdout.getReader();
    const deadline = Date.now() + 40000;
    while (replies.filter((r) => r.id !== undefined).length < waitFor && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      parse(new TextDecoder().decode(value));
    }
    proc.stdin.end();
    await proc.exited;
    return replies;
  };

  const startCount = (log: string): number => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);

  test("cold run spawns the server and caches; a warm listing run never spawns it; a call does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lazy-e2e-"));
    const log = join(dir, "starts.log");
    const handshake: JsonRpc[] = [initialize, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }];

    const cold = await session(dir, log, handshake, 2);
    expect(cold.find((r) => r.id === 2)).toMatchObject({ result: { tools: [{ name: "echo" }] } });
    expect(startCount(log)).toBe(1);

    const warm = await session(dir, log, handshake, 2);
    expect(warm.find((r) => r.id === 2)).toMatchObject({ result: { tools: [{ name: "echo" }] } });
    expect(startCount(log)).toBe(1);

    const call = await session(dir, log, [...handshake, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } }], 3);
    expect(call.find((r) => r.id === 3)).toMatchObject({ result: { content: [{ text: "echo:hi" }] } });
    expect(startCount(log)).toBe(2);
  }, 150000);
});
