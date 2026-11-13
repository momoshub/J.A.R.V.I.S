import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// each helper call is a few processes (bash, python, curl, jq) and the box is shared
setDefaultTimeout(30_000);

const BIN = join(import.meta.dir, "..", "..", "bin");
const TICKET = "jvsl_test-ticket";

type Seen = { path: string; body: Record<string, unknown> };

/** A stand-in for the bot's Slack proxy. `answer` decides the reply per method; every request is recorded. */
const fakeBot = (answer: (method: string, params: Record<string, string>) => Response = () => Response.json({ ok: true })) => {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/upload") return new Response("ok");
      const body = (await req.json()) as Record<string, unknown>;
      seen.push({ path, body });
      if (path === "/api/slack/file") {
        return body.url === "https://files.slack.com/files-pri/T1-F1/pic.png"
          ? new Response("PNGBYTES", { headers: { "content-type": "image/png" } })
          : Response.json({ error: "not a Slack file url" }, { status: 403 });
      }
      return answer(String(body.method), (body.params ?? {}) as Record<string, string>);
    },
  });
  return { seen, server, url: `http://127.0.0.1:${server.port}/api/slack` };
};

let bot: ReturnType<typeof fakeBot> | undefined;
const dirs: string[] = [];
afterEach(() => {
  bot?.server.stop(true);
  bot = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const run = async (script: string, args: string[], env: Record<string, string | undefined> = {}) => {
  const proc = Bun.spawn({
    cmd: ["bash", join(BIN, script), ...args],
    stdout: "pipe",
    stderr: "pipe",
    // the bot's token is not in a turn's environment, so it is not in this one either
    env: { ...process.env, SLACK_BOT_TOKEN: undefined, JARVIS_SLACK_TICKET: undefined, JARVIS_SLACK_API_URL: undefined, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
};

describe("slack-api.sh", () => {
  test("hands the ticket and the call to the bot, and prints Slack's answer as it came", async () => {
    bot = fakeBot(() => Response.json({ ok: true, channel: "C1", ts: "1.2", message: { text: "a=b" } }));
    const { stdout, code } = await run("slack-api.sh", ["chat.postMessage", "channel=C1", "thread_ts=1.1", "text=line one\nline two = still text"], {
      JARVIS_SLACK_TICKET: TICKET,
      JARVIS_SLACK_API_URL: bot.url,
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ok: true, channel: "C1", ts: "1.2", message: { text: "a=b" } });
    expect(bot.seen).toEqual([
      {
        path: "/api/slack/proxy",
        body: { ticket: TICKET, method: "chat.postMessage", params: { channel: "C1", thread_ts: "1.1", text: "line one\nline two = still text" } },
      },
    ]);
  });

  test("a call the bot refuses prints the refusal, and nothing is retried or worked around", async () => {
    bot = fakeBot(() => Response.json({ ok: false, error: "jarvis_proxy: method_not_allowed: chat.delete" }, { status: 403 }));
    const { stdout, code } = await run("slack-api.sh", ["chat.delete", "channel=C1", "ts=1.1"], {
      JARVIS_SLACK_TICKET: TICKET,
      JARVIS_SLACK_API_URL: bot.url,
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout).error).toContain("method_not_allowed");
    expect(bot.seen).toHaveLength(1);
  });

  test("without a ticket it stops before any request, whatever else is in the environment", async () => {
    bot = fakeBot();
    const { stderr, code } = await run("slack-api.sh", ["users.info", "user=U1"], {
      JARVIS_SLACK_API_URL: bot.url,
      // a token in the environment is no substitute: the helper never reads one
      SLACK_BOT_TOKEN: "xoxb-should-be-ignored",
    });
    expect(code).toBe(3);
    expect(stderr).toContain("no Slack ticket");
    expect(bot.seen).toHaveLength(0);
  });

  test("a malformed argument is refused before any request", async () => {
    bot = fakeBot();
    const { stderr, code } = await run("slack-api.sh", ["users.info", "user"], { JARVIS_SLACK_TICKET: TICKET, JARVIS_SLACK_API_URL: bot.url });
    expect(code).toBe(2);
    expect(stderr).toContain("key=value");
    expect(bot.seen).toHaveLength(0);
    expect((await run("slack-api.sh", [], { JARVIS_SLACK_TICKET: TICKET })).code).toBe(2);
  });

  test("a bot that cannot be reached is an error, not an empty answer", async () => {
    const { code, stderr } = await run("slack-api.sh", ["users.info", "user=U1"], {
      JARVIS_SLACK_TICKET: TICKET,
      JARVIS_SLACK_API_URL: "http://127.0.0.1:9/api/slack",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("could not reach");
  });
});

describe("slack-react.sh", () => {
  test("reacts through the bot, tolerating :shortcode: and counting only the ones that landed", async () => {
    bot = fakeBot((_m, p) => Response.json(p.name === "eyes" ? { ok: true } : { ok: false, error: "already_reacted" }));
    const { stdout, code } = await run("slack-react.sh", ["C1", "1.1", ":eyes:", "fire"], { JARVIS_SLACK_TICKET: TICKET, JARVIS_SLACK_API_URL: bot.url });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("added 1/2");
    expect(bot.seen.map((s) => [s.body.method, s.body.params])).toEqual([
      ["reactions.add", { channel: "C1", timestamp: "1.1", name: "eyes" }],
      ["reactions.add", { channel: "C1", timestamp: "1.1", name: "fire" }],
    ]);
  });
});

describe("slack-file.sh", () => {
  test("a private file comes back through the bot, which fetches it with the token", async () => {
    bot = fakeBot();
    const dir = mkdtempSync(join(tmpdir(), "slack-file-test-"));
    dirs.push(dir);
    const dest = join(dir, "pic.png");
    const { stdout, code } = await run("slack-file.sh", ["https://files.slack.com/files-pri/T1-F1/pic.png", dest], {
      JARVIS_SLACK_TICKET: TICKET,
      JARVIS_SLACK_API_URL: bot.url,
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(dest);
    expect(readFileSync(dest, "utf8")).toBe("PNGBYTES");
    expect(bot.seen[0]).toEqual({ path: "/api/slack/file", body: { ticket: TICKET, url: "https://files.slack.com/files-pri/T1-F1/pic.png" } });
  });

  test("a url that is not Slack's never leaves the script, and a refusal leaves no file behind", async () => {
    bot = fakeBot();
    const refused = await run("slack-file.sh", ["https://evil.example/a.png"], { JARVIS_SLACK_TICKET: TICKET, JARVIS_SLACK_API_URL: bot.url });
    expect(refused.code).toBe(2);
    expect(bot.seen).toHaveLength(0);

    const dir = mkdtempSync(join(tmpdir(), "slack-file-test-"));
    dirs.push(dir);
    const dest = join(dir, "other.png");
    const denied = await run("slack-file.sh", ["https://files.slack.com/files-pri/T1-F9/other.png", dest], {
      JARVIS_SLACK_TICKET: TICKET,
      JARVIS_SLACK_API_URL: bot.url,
    });
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("http 403");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("without a ticket it does not even try", async () => {
    bot = fakeBot();
    const { code } = await run("slack-file.sh", ["https://files.slack.com/files-pri/T1-F1/pic.png"], { JARVIS_SLACK_API_URL: bot.url });
    expect(code).toBe(3);
    expect(bot.seen).toHaveLength(0);
  });
});

describe("slack-upload.sh", () => {
  test("reserves, uploads the bytes to the pre-signed url, and completes into the turn's thread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slack-upload-test-"));
    dirs.push(dir);
    const file = join(dir, "shot.png");
    writeFileSync(file, "PNG");
    bot = fakeBot((method) =>
      method === "files.getUploadURLExternal"
        ? Response.json({ ok: true, upload_url: `${bot!.url.replace("/api/slack", "")}/upload`, file_id: "F123" })
        : Response.json({ ok: true }),
    );
    const { stdout, code } = await run("slack-upload.sh", ["C1", "1.1", file, "a shot", "here it is"], {
      JARVIS_SLACK_TICKET: TICKET,
      JARVIS_SLACK_API_URL: bot.url,
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("F123");
    const calls = bot.seen.map((s) => [s.body.method, s.body.params] as const);
    expect(calls[0]).toEqual(["files.getUploadURLExternal", { filename: "shot.png", length: "3" }]);
    const [method, params] = calls[1]!;
    expect(method).toBe("files.completeUploadExternal");
    expect(params).toMatchObject({ channel_id: "C1", thread_ts: "1.1", initial_comment: "here it is" });
    expect(JSON.parse((params as Record<string, string>).files!)).toEqual([{ id: "F123", title: "a shot" }]);
  });
});

describe("no helper reads the bot's token from the environment", () => {
  test("nothing in bin/ names SLACK_BOT_TOKEN", () => {
    // the guard for this whole change: a turn's environment has no Slack token, so a helper that asks for one is
    // either dead on arrival or a reason to put it back
    const offenders = readdirSync(BIN)
      .filter((f) => /\.(sh|ts|js)$/.test(f))
      .filter((f) => readFileSync(join(BIN, f), "utf8").includes("SLACK_BOT_TOKEN"));
    expect(offenders).toEqual([]);
  });

  test("no prompt text in src/domain tells a turn to use $SLACK_BOT_TOKEN", () => {
    const domain = join(import.meta.dir, "..", "..", "src", "domain");
    const offenders = readdirSync(domain)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => readFileSync(join(domain, f), "utf8").includes("SLACK_BOT_TOKEN"));
    expect(offenders).toEqual([]);
  });
});
