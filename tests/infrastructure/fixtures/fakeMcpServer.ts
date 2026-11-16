// A minimal stdio MCP server for the lazy proxy tests: one tool, `echo`.
// Appends a line to $FAKE_MCP_LOG on every start so a test can count spawns.
import { appendFileSync } from "node:fs";

if (process.env.FAKE_MCP_LOG) appendFileSync(process.env.FAKE_MCP_LOG, "start\n");
const send = (m: object): void => void process.stdout.write(`${JSON.stringify(m)}\n`);
let buf = "";
for await (const chunk of process.stdin) {
  buf += new TextDecoder().decode(chunk);
  let at: number;
  while ((at = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, at)) as { id?: number | string; method?: string; params?: { arguments?: { text?: string } } };
    buf = buf.slice(at + 1);
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    } else if (m.method === "tools/list") {
      send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }] } });
    } else if (m.method === "tools/call") {
      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `echo:${m.params?.arguments?.text ?? ""}` }] } });
    }
  }
}
