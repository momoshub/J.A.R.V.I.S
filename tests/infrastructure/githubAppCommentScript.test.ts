import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "bin", "github-app-comment.sh");

const run = async (args: string[], env: Record<string, string>) => {
  const server = Bun.serve({ port: 0, fetch: async (req) => new Response(await req.text()) });
  try {
    const proc = Bun.spawn({
      cmd: ["bash", SCRIPT, ...args],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GITHUB_APP_COMMENT_URL: `http://127.0.0.1:${server.port}/c`, ...env },
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, code };
  } finally {
    server.stop(true);
  }
};

describe("github-app-comment.sh", () => {
  test("sends the ticket from the environment with repo, number and the file's body", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "gh-comment-")), "body.md");
    writeFileSync(file, "## Answer\nit's \"fixed\"\n");
    const { stdout, code } = await run(["acme/api", "7", file], { JARVIS_RUN_TICKET: "t".repeat(32) });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ticket: "t".repeat(32), repo: "acme/api", number: 7, body: "## Answer\nit's \"fixed\"\n" });
  });

  test("a worker's ticket file: line 2 is the endpoint unless the URL or DASHBOARD_PORT is set", async () => {
    const server = Bun.serve({ port: 0, fetch: async (req) => new Response(JSON.stringify({ path: new URL(req.url).pathname })) });
    try {
      const dir = mkdtempSync(join(tmpdir(), "gh-comment-"));
      const body = join(dir, "body.md");
      writeFileSync(body, "hi");
      const ticketFile = join(dir, "t");
      writeFileSync(ticketFile, `jvwk_x\nhttp://127.0.0.1:${server.port}\n`);
      const call = async (env: Record<string, string>) => {
        const proc = Bun.spawn({
          cmd: ["bash", SCRIPT, "acme/api", "7", body],
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, JARVIS_RUN_TICKET: "", JARVIS_RUN_TICKET_FILE: ticketFile, GITHUB_APP_COMMENT_URL: "", DASHBOARD_PORT: "", ...env },
        });
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        return { stdout, stderr, code };
      };
      const fromFile = await call({});
      expect(fromFile.code).toBe(0);
      expect(JSON.parse(fromFile.stdout)).toEqual({ path: "/api/github-app/comment" });
      const port = await call({ DASHBOARD_PORT: "1" });
      expect(port.code).toBe(1);
      expect(port.stderr).toContain("http://127.0.0.1:1/api/github-app/comment");
      // Nothing below sends a request: the endpoint is printed, so no real port is touched.
      const printed = async (line2: string) => {
        writeFileSync(ticketFile, line2 === "" ? "jvwk_x\n" : `jvwk_x\n${line2}\n`);
        const r = await call({ GITHUB_APP_PRINT_ENDPOINT: "1" });
        expect(r.code).toBe(0);
        return r.stdout.trim();
      };
      const dflt = "http://127.0.0.1:2001/api/github-app/comment";
      expect(await printed("")).toBe(dflt);
      expect(await printed("http://evil.example:80")).toBe(dflt);
      for (const bad of ["http://127.0.0.1:1@evil.example", "http://127.0.0.1:2002/x", "http://127.0.0.1:", "http://127.0.0.1:80a"]) {
        expect(await printed(bad)).toBe(dflt);
      }
      expect(await printed("http://127.0.0.1:2002")).toBe("http://127.0.0.1:2002/api/github-app/comment");
    } finally {
      server.stop(true);
    }
  });

  test("refuses without a ticket", async () => {
    const { code } = await run(["acme/api", "7", "/nonexistent"], { JARVIS_RUN_TICKET: "" });
    expect(code).toBe(3);
  });
});
