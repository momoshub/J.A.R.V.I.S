import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "bin", "github-app.sh");
const TICKET = "t".repeat(32);
/** Each call starts bash, python3 and often git: slow hosts need more than bun's 5s. */
const SLOW = 30_000;

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
  }, SLOW);

  test("the other actions", async () => {
    expect((await run(["comment", "o/r", "5", file("hi")])).json()).toMatchObject({ action: "comment", number: 5, body: "hi" });
    expect((await run(["review", "o/r", "5", "APPROVE"])).json()).toMatchObject({ action: "review", event: "APPROVE" });
    expect((await run(["review", "o/r", "5", "COMMENT", file("x")])).json()).toMatchObject({ event: "COMMENT", body: "x" });
    expect((await run(["pr-edit", "o/r", "5", "--title", "N"])).json()).toMatchObject({ action: "pr-edit", title: "N" });
    expect((await run(["pr-close", "o/r", "5"])).json()).toMatchObject({ action: "pr-close", number: 5 });
    expect((await run(["pr-merge", "o/r", "5", "--method", "squash"])).json()).toMatchObject({ method: "squash" });
    expect((await run(["labels-add", "o/r", "5", "a", "b c"])).json()).toMatchObject({ labels: ["a", "b c"] });
    expect((await run(["reviewers-request", "o/r", "5", "bob", "team:core"])).json()).toMatchObject({ reviewers: ["bob", "team:core"] });
  }, SLOW);

  test("refuses without a ticket, and never takes one as an argument", async () => {
    expect((await run(["pr-close", "o/r", "5"], { JARVIS_RUN_TICKET: "" })).code).toBe(3);
    const r = await run(["pr-close", "o/r", "5", "--ticket", "abc"]);
    expect(r.code).toBe(2);
  }, SLOW);

  test("bad usage exits 2", async () => {
    expect((await run(["pr-close", "o/r", "nope"])).code).toBe(2);
    expect((await run(["wat", "o/r"])).code).toBe(2);
    expect((await run(["comment", "o/r", "5", "/nonexistent"])).code).toBe(2);
  }, SLOW);
});

describe("github-app.sh git and push", () => {
  const TOKEN = "ghs_SECRET_installation_token";
  const bot = { token: TOKEN, name: "jarvis-at-acme[bot]", email: "1234+jarvis-at-acme[bot]@users.noreply.github.com" };

  const sh = (cmd: string[], cwd: string) => {
    const r = Bun.spawnSync({ cmd, cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };

  /** A clone whose `origin` is github.com/o/r, rewritten to a local bare repo for the test. */
  const clone = () => {
    const root = mkdtempSync(join(tmpdir(), "gh-app-git-"));
    const bare = join(root, "remote.git");
    const dir = join(root, "work");
    sh(["git", "init", "-q", "--bare", bare], root);
    sh(["git", "init", "-q", "-b", "main", dir], root);
    sh(["git", "remote", "add", "origin", "https://github.com/O/R.git"], dir);
    sh(["git", "config", `url.${bare}.insteadOf`, "https://github.com/O/R.git"], dir);
    sh(["git", "config", "user.name", "Kai"], dir);
    sh(["git", "config", "user.email", "kai@example.com"], dir);
    sh(["git", "config", "commit.gpgsign", "true"], dir);
    writeFileSync(join(dir, "a.txt"), "a\n");
    sh(["git", "add", "a.txt"], dir);
    return { dir, bare };
  };

  const gh = async (args: string[], reply: unknown = { ok: true, github: bot }) => {
    const seen: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seen.push((await req.json()) as Record<string, unknown>);
        return Response.json(reply);
      },
    });
    try {
      const proc = Bun.spawn({
        cmd: ["bash", SCRIPT, ...args],
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          JARVIS_RUN_TICKET: TICKET,
          GITHUB_APP_ACTION_URL: `http://127.0.0.1:${server.port}/a`,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout: stdout.trim(), stderr, code, seen };
    } finally {
      server.stop(true);
    }
  };

  test("commit is authored and committed as the bot, unsigned, and asks the bot for git-auth with the ticket", async () => {
    const { dir } = clone();
    const r = await gh(["git", "o/r", dir, "--", "commit", "-q", "-m", "fix: x"]);
    expect(r.code).toBe(0);
    expect(r.seen).toEqual([{ ticket: TICKET, action: "git-auth", repo: "o/r" }]);
    expect(sh(["git", "log", "-1", "--format=%an <%ae> | %cn <%ce>"], dir)).toBe(
      `${bot.name} <${bot.email}> | ${bot.name} <${bot.email}>`,
    );
    expect(sh(["git", "cat-file", "commit", "HEAD"], dir)).not.toContain("gpgsig");
  }, SLOW);

  test("the token is a one-shot credential: in git's environment only, never in config, remotes or output", async () => {
    const { dir } = clone();
    const r = await gh(["git", "o/r", dir, "--", "config", "--get-all", "http.https://github.com/.extraheader"]);
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    expect(r.stdout).toBe(`AUTHORIZATION: basic ${basic}`);
    expect(readFileSync(join(dir, ".git", "config"), "utf8")).not.toContain(TOKEN);
    expect(readFileSync(join(dir, ".git", "config"), "utf8")).not.toContain(basic);
    expect(Bun.spawnSync({ cmd: ["git", "config", "--get-all", "http.https://github.com/.extraheader"], cwd: dir }).exitCode).toBe(1);
  }, SLOW);
  test("an ssh remote is read as https, so the header applies", async () => {
    const { dir } = clone();
    sh(["git", "remote", "add", "sshy", "git@github.com:O/R.git"], dir);
    const r = await gh(["git", "o/r", dir, "--", "ls-remote", "--get-url", "sshy"]);
    expect(r.stdout).toBe("https://github.com/O/R.git");
  }, SLOW);

  test("push sends the branch to the remote that points at the repo", async () => {
    const { dir, bare } = clone();
    await gh(["git", "o/r", dir, "--", "commit", "-q", "-m", "fix: x"]);
    sh(["git", "checkout", "-q", "-b", "fix/x"], dir);
    const r = await gh(["push", "o/r", dir, "fix/x"]);
    expect(r.code).toBe(0);
    expect(sh(["git", "--git-dir", bare, "log", "-1", "--format=%an", "fix/x"], dir)).toBe(bot.name);
  }, SLOW);

  test("push --force-with-lease refuses to overwrite what it has not seen", async () => {
    const { dir, bare } = clone();
    await gh(["git", "o/r", dir, "--", "commit", "-q", "-m", "one"]);
    sh(["git", "checkout", "-q", "-b", "fix/x"], dir);
    expect((await gh(["push", "o/r", dir, "fix/x"])).code).toBe(0);
    // Someone else moves the branch on the remote; the clone never fetched it.
    const other = join(dir, "..", "other");
    sh(["git", "clone", "-q", bare, other], dir);
    sh(["git", "checkout", "-q", "fix/x"], other);
    sh(["git", "-c", "user.name=O", "-c", "user.email=o@x", "commit", "-q", "--allow-empty", "-m", "theirs"], other);
    sh(["git", "push", "-q", "origin", "fix/x"], other);
    sh(["git", "commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "mine"], dir);
    const r = await gh(["push", "o/r", dir, "fix/x", "--force-with-lease"]);
    expect(r.code).not.toBe(0);
  }, SLOW);

  test("push refuses a repo no remote points at, a bad branch and a bad flag, before asking for a token", async () => {
    const { dir } = clone();
    for (const args of [
      ["push", "other/repo", dir, "fix/x"],
      ["push", "o/r", dir, "bad..name"],
      ["push", "o/r", dir, "fix/x", "--force"],
      ["push", "o/r", "/nonexistent", "fix/x"],
      ["git", "o/r", dir, "--"],
    ]) {
      const r = await gh(args);
      expect(r.code).toBe(2);
      expect(r.seen).toEqual([]);
    }
  }, SLOW);

  test("the bot's refusal is printed and git does not run", async () => {
    const { dir } = clone();
    const r = await gh(["git", "o/r", dir, "--", "commit", "-m", "x"], { ok: false, error: "needs the admin role" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("needs the admin role");
    expect(Bun.spawnSync({ cmd: ["git", "-C", dir, "rev-parse", "--verify", "HEAD"] }).exitCode).not.toBe(0);
  }, SLOW);

  test("no ticket, no git", async () => {
    const { dir } = clone();
    const proc = Bun.spawnSync({ cmd: ["bash", SCRIPT, "git", "o/r", dir, "--", "status"], env: { ...process.env, JARVIS_RUN_TICKET: "" } });
    expect(proc.exitCode).toBe(3);
  }, SLOW);
});
