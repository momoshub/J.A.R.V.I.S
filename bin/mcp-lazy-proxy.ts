#!/usr/bin/env bun
//
// Lazy stdio MCP proxy (see src/infrastructure/mcp/lazyProxy.ts). The bot puts it
// in front of every stdio server of a turn's --mcp-config:
//
//   mcp-lazy-proxy.ts --name <server> --cache-dir <dir> -- <command> [args...]
//
// Speaks MCP on stdin/stdout, answers initialize and the list methods (tools, prompts,
// resources) from the schema cache in <dir>, and starts <command> only for the first request that needs the
// real server. The environment it runs with is the real server's.
import {
  createFileSchemaCache,
  createLazyProxy,
  createLineParser,
  schemaCachePath,
  type JsonRpc,
  type RealServer,
} from "../src/infrastructure/mcp/lazyProxy.ts";

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

const spawnReal = (): RealServer => {
  const proc = Bun.spawn({ cmd: command, stdin: "pipe", stdout: "pipe", stderr: "inherit", env: process.env });
  let listener: (msg: JsonRpc) => void = () => {};
  const parse = createLineParser((m) => listener(m));
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of proc.stdout) parse(decoder.decode(chunk, { stream: true }));
  })();
  return {
    send: (msg) => {
      proc.stdin.write(`${JSON.stringify(msg)}\n`);
      void proc.stdin.flush();
    },
    onMessage: (cb) => {
      listener = cb;
    },
    onExit: (cb) => void proc.exited.then(cb),
    kill: () => proc.kill(),
  };
};

const proxy = createLazyProxy({
  cache: createFileSchemaCache(schemaCachePath(cacheDir, name, command)),
  spawn: spawnReal,
  out: write,
  log: (line) => console.error(`[mcp-lazy-proxy ${name}] ${line}`),
});

const parse = createLineParser((msg) => void proxy.handle(msg));
const decoder = new TextDecoder();
for await (const chunk of process.stdin) parse(decoder.decode(chunk, { stream: true }));
proxy.close();
process.exit(0);
