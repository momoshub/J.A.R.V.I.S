import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "bin", "github-app.sh");
const TICKET = "t".repeat(32);

const run = async (args: string[], env: Record<string, string> = { JARVIS_RUN_TICKET: TICKET }) => {
  const server = Bun.serve({ port: 0, fetch: async (req) => new Response(await req.text()) });
  try {
    const proc = Bun.spawn({
      cmd: ["bash", SCRIPT, ...args],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GITHUB_APP_ACTION_URL: `http://127.0.0.1:${server.port}/a`, ...env },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code, json: () => JSON.parse(stdout) as Record<string, unknown> };
  } finally {
    server.stop(true);
  }
};

const file = (text: string) => {
  const f = join(mkdtempSync(join(tmpdir(), "gh-app-")), "body.md");
  writeFileSync(f, text);
  return f;
};

describe("github-app.sh", () => {
  test("pr-create sends the ticket from the environment and every field", async () => {
    const r = await run(["pr-create", "o/r", "--head", "fix/x", "--base", "master", "--title", "My \"title\"", "--body-file", file("body\n"), "--draft"]);
    expect(r.json()).toEqual({
      ticket: TICKET,
      action: "pr-create",
      repo: "o/r",
      head: "fix/x",
      base: "master",
      title: 'My "title"',
      draft: true,
      body: "body\n",
    });
  });

  test("the other actions", async () => {
    expect((await run(["comment", "o/r", "5", file("hi")])).json()).toMatchObject({ action: "comment", number: 5, body: "hi" });
    expect((await run(["review", "o/r", "5", "APPROVE"])).json()).toMatchObject({ action: "review", event: "APPROVE" });
    expect((await run(["review", "o/r", "5", "COMMENT", file("x")])).json()).toMatchObject({ event: "COMMENT", body: "x" });
    expect((await run(["pr-edit", "o/r", "5", "--title", "N"])).json()).toMatchObject({ action: "pr-edit", title: "N" });
    expect((await run(["pr-close", "o/r", "5"])).json()).toMatchObject({ action: "pr-close", number: 5 });
    expect((await run(["pr-merge", "o/r", "5", "--method", "squash"])).json()).toMatchObject({ method: "squash" });
    expect((await run(["labels-add", "o/r", "5", "a", "b c"])).json()).toMatchObject({ labels: ["a", "b c"] });
    expect((await run(["reviewers-request", "o/r", "5", "bob", "team:core"])).json()).toMatchObject({ reviewers: ["bob", "team:core"] });
  });

  test("refuses without a ticket, and never takes one as an argument", async () => {
    expect((await run(["pr-close", "o/r", "5"], { JARVIS_RUN_TICKET: "" })).code).toBe(3);
    const r = await run(["pr-close", "o/r", "5", "--ticket", "abc"]);
    expect(r.code).toBe(2);
  });

  test("bad usage exits 2", async () => {
    expect((await run(["pr-close", "o/r", "nope"])).code).toBe(2);
    expect((await run(["wat", "o/r"])).code).toBe(2);
    expect((await run(["comment", "o/r", "5", "/nonexistent"])).code).toBe(2);
  });
});
