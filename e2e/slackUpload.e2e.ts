/**
 * End-to-end: a file upload into a thread, against real Slack.
 *
 * Opt-in like `slackBlockKit.e2e.ts` (`JARVIS_E2E=1` + `SLACK_BOT_TOKEN`; see
 * `bun run test:e2e`). It runs the real `bin/slack-upload.sh` - the helper the
 * sandboxed session is allowed to call - which does `files.getUploadURLExternal`,
 * the byte upload and `files.completeUploadExternal` with `thread_ts`. The file
 * must land in the thread, and must not show up at the channel root, where the
 * person asking would never see it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANNEL, KEEP, TOKEN, enabled, openThread, type E2eThread, type SlackMessage } from "./support.ts";

const SCRIPT = join(import.meta.dir, "..", "bin", "slack-upload.sh");

describe.skipIf(!enabled)("uploading a file into a thread against real Slack", () => {
  let t: E2eThread;
  let dir = "";
  let fileId = "";
  beforeAll(async () => {
    t = await openThread("upload");
    dir = mkdtempSync(join(tmpdir(), "jarvis-e2e-"));
  });
  afterAll(async () => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (!t) return;
    await t.cleanup();
    if (fileId && !KEEP) await t.web.files.delete({ file: fileId }).catch(() => {});
  });

  test("lands in the thread (thread_ts), not at the channel root", async () => {
    const file = join(dir, "e2e-upload.txt");
    writeFileSync(file, `jarvis e2e upload ${Date.now()}\n`);
    const proc = Bun.spawn({
      cmd: [SCRIPT, CHANNEL, t.rootTs, file, "e2e upload", "e2e upload comment"],
      env: { ...process.env, SLACK_BOT_TOKEN: TOKEN },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
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
