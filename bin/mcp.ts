#!/usr/bin/env bun
//
// Code-mode MCP CLI (see src/infrastructure/mcp/codeMode.ts): list, search and call the bot's MCP servers from the
// shell, with the full result written to a file and only a short summary printed.
//
//   bun bin/mcp.ts list | search <query> | schema <server> <tool> | call <server> <tool> '<json>' [--fields a,b.c]
import { runMcpCli } from "../src/infrastructure/mcp/codeMode.ts";

const code = await runMcpCli(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
process.exit(code);
