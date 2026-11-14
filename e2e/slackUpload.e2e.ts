/**
 * End-to-end: a file upload into a thread, against real Slack.
 *
 * Opt-in like `slackBlockKit.e2e.ts` (`JARVIS_E2E=1` + `SLACK_BOT_TOKEN`; see
 * `bun run test:e2e`). It runs the real `bin/slack-upload.sh` - the helper the
 * sandboxed session is allowed to call - which does `files.getUploadURLExternal`,
 * the byte upload and `files.completeUploadExternal` with `thread_ts`. The file
 * must land in the thread, and must not show up at the channel root, where the
 * person asking would never see it.
 *
 * The script never holds a Slack token: its two Slack calls go through the bot's
 * proxy with a one-turn ticket (`bin/slack-api.sh`). So the test stands up the
 * real `createSlackProxy` + `createSlackTickets` behind a loopback server, mints
 * a ticket for the test channel and thread, and hands the script only that, as
 * a turn's environment would.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSlackProxy } from "../src/application/slackProxy.ts";
import { createSlackTickets } from "../src/application/slackTickets.ts";
import { CHANNEL, KEEP, TOKEN, enabled, openThread, type E2eThread, type SlackMessage } from "./support.ts";

const SCRIPT = join(import.meta.dir, "..", "bin", "slack-upload.sh");

describe.skipIf(!enabled)("uploading a file into a thread against real Slack", () => {
  let t: E2eThread;
  let dir = "";
  let fileId = "";
  const tickets = createSlackTickets(() => Date.now());
  const proxy = createSlackProxy({ tickets, botToken: TOKEN });
  // The same route the dashboard serves at /api/slack/proxy, on a free loopback port.
  let server: ReturnType<typeof Bun.serve> | undefined;
  beforeAll(async () => {
    t = await openThread("upload");
    dir = mkdtempSync(join(tmpdir(), "jarvis-e2e-"));
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        if (req.method !== "POST" || new URL(req.url).pathname !== "/api/slack/proxy") return new Response("not found", { status: 404 });
        const body = (await req.json()) as { ticket?: unknown; method?: unknown; params?: unknown };
        const answer = await proxy.call({ ticket: body.ticket, method: body.method, params: body.params });
        return new Response(answer.body, { status: answer.status, headers: { "content-type": "application/json" } });
      },
    });
  });
  afterAll(async () => {
    server?.stop(true);
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (!t) return;
    await t.cleanup();
    if (fileId && !KEEP) await t.web.files.delete({ file: fileId }).catch(() => {});
  });

  test("lands in the thread (thread_ts), not at the channel root", async () => {
    const file = join(dir, "e2e-upload.txt");
    writeFileSync(file, `jarvis e2e upload ${Date.now()}\n`);
    const ticket = tickets.issue({ channel: CHANNEL, threadTs: t.rootTs });
    // A turn's environment: a ticket and the proxy url, never the bot token.
    const { SLACK_BOT_TOKEN: _token, ...env } = process.env;
    const proc = Bun.spawn({
      cmd: [SCRIPT, CHANNEL, t.rootTs, file, "e2e upload", "e2e upload comment"],
      env: { ...env, JARVIS_SLACK_TICKET: ticket, JARVIS_SLACK_API_URL: `http://127.0.0.1:${server?.port}/api/slack` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    tickets.revoke(ticket);
    expect(err.trim()).toBe("");
    expect(code).toBe(0);
    fileId = out.trim();
    expect(fileId).toMatch(/^F[A-Z0-9]+$/);

    const shared = await t.waitFor((all) => all.find((m) => m.files?.some((f) => f.id === fileId)));
    expect(shared).toBeDefined();
    const m = shared as SlackMessage;
    t.track(m.ts);
    console.log(`  upload case: file ${fileId} in message ${m.ts}, thread_ts ${m.thread_ts}`);
    expect(m.thread_ts).toBe(t.rootTs);

    // Not at the root: the channel history (top level only) after our root must not carry it.
    const history = await t.web.conversations.history({ channel: CHANNEL, oldest: t.rootTs, inclusive: true, limit: 50 });
    const atRoot = ((history.messages ?? []) as SlackMessage[]).filter((x) => x.files?.some((f) => f.id === fileId) && x.thread_ts !== t.rootTs);
    expect(atRoot).toHaveLength(0);
  }, 90_000);
});
