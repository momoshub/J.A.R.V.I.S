// A stdio MCP server for the `mcp` CLI tests: `run_query` answers JSON rows, `drop_table` and `boom` exist too.
// $FAKE_MCP_TOOLS (comma list) limits what it lists; $FAKE_MCP_SECRET proves the server's own env arrives.
const all: Record<string, { description: string; inputSchema: object }> = {
  run_query: { description: "Run a SQL query and return rows", inputSchema: { type: "object", properties: { sql: { type: "string" } } } },
  drop_table: { description: "Drop a table", inputSchema: { type: "object" } },
  boom: { description: "Always fails", inputSchema: { type: "object" } },
};
const listed = (process.env.FAKE_MCP_TOOLS ?? Object.keys(all).join(",")).split(",");
const send = (m: object): void => void process.stdout.write(`${JSON.stringify(m)}\n`);
let buf = "";
for await (const chunk of process.stdin) {
  buf += new TextDecoder().decode(chunk);
  let at: number;
  while ((at = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, at)) as { id?: number | string; method?: string; params?: { name?: string; arguments?: { sql?: string } } };
    buf = buf.slice(at + 1);
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fakedb", version: "1" } } });
    } else if (m.method === "tools/list") {
      send({ jsonrpc: "2.0", id: m.id, result: { tools: listed.map((name) => ({ name, ...all[name]! })) } });
    } else if (m.method === "tools/call") {
      if (m.params?.name === "boom") {
        send({ jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: "it broke" }] } });
      } else {
        const rows = [1, 2, 3, 4, 5].map((id) => ({ id, name: `row${id}`, secret: process.env.FAKE_MCP_SECRET ?? "", blob: "x".repeat(40) }));
        send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ sql: m.params?.arguments?.sql, rows }) }] } });
      }
    }
  }
}
