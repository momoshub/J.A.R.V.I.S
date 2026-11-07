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

  test("refuses without a ticket", async () => {
    const { code } = await run(["acme/api", "7", "/nonexistent"], { JARVIS_RUN_TICKET: "" });
    expect(code).toBe(3);
  });
});
