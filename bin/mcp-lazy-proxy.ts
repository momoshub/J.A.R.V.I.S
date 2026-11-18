#!/usr/bin/env bun
//
// Lazy stdio MCP proxy (see src/infrastructure/mcp/lazyProxy.ts). The bot puts it
// in front of every stdio server of a turn's --mcp-config:
//
//   mcp-lazy-proxy.ts --name <server> --cache-dir <dir> -- <command> [args...]
//
// Speaks MCP on stdin/stdout, answers initialize and the list methods (tools, prompts,
// resources) from the schema cache in <dir>, and starts <command> only for the first request that needs the
// real server. The environment it runs with is the real server's. A tool the server lists that the owner has not
// approved (`mcp-tools approve`) is hidden and refused; the server's first run is its baseline.
import {
  createFileSchemaCache,
  createLazyProxy,
  createLineParser,
  schemaCachePath,
  spawnStdioServer,
  type JsonRpc,
} from "../src/infrastructure/mcp/lazyProxy.ts";
import { approvalsPath, createFileApprovalStore } from "../src/infrastructure/mcp/approvals.ts";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const flags = split < 0 ? argv : argv.slice(0, split);
const command = split < 0 ? [] : argv.slice(split + 1);
const flag = (name: string): string | undefined => {
  const at = flags.indexOf(name);
  return at >= 0 ? flags[at + 1] : undefined;
};
const name = flag("--name");
const cacheDir = flag("--cache-dir");
if (!name || !cacheDir || command.length === 0) {
  console.error("usage: mcp-lazy-proxy.ts --name <server> --cache-dir <dir> -- <command> [args...]");
  process.exit(2);
}

const write = (msg: JsonRpc): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

const proxy = createLazyProxy({
  cache: createFileSchemaCache(schemaCachePath(cacheDir, name, command)),
  spawn: () => spawnStdioServer(command),
  server: name,
  approvals: createFileApprovalStore(approvalsPath(cacheDir, name)),
  out: write,
  log: (line) => console.error(`[mcp-lazy-proxy ${name}] ${line}`),
});

const parse = createLineParser((msg) => void proxy.handle(msg));
const decoder = new TextDecoder();
for await (const chunk of process.stdin) parse(decoder.decode(chunk, { stream: true }));
proxy.close();
process.exit(0);
