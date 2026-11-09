/**
 * End-to-end: a watch with a shell check fires and hands back, against real Slack.
 *
 * Opt-in like `slackBlockKit.e2e.ts` (`JARVIS_E2E=1` + `SLACK_BOT_TOKEN`; see
 * `bun run test:e2e`). The smallest real path: a real `createWatcher` over a
 * real (in-memory) `watchRepo`, a real `createShellCheck` running a real
 * `/bin/sh` command, and a hand-back that posts into the watched thread on
 * Slack. Only the turn itself is not the model: `runTurn` posts the hand-back
 * text the watcher built, which is what the thread would be woken with.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWatcher } from "../src/application/watcher.ts";
import { createShellCheck } from "../src/infrastructure/system/shellCheck.ts";
import { openDatabase } from "../src/infrastructure/db/client.ts";
import { createWatchRepo } from "../src/infrastructure/db/watchRepo.ts";
import { CHANNEL, enabled, openThread, type E2eThread } from "./support.ts";

describe.skipIf(!enabled)("a watch with a shell check against real Slack", () => {
  let t: E2eThread;
  let dir = "";
  beforeAll(async () => {
    t = await openThread("watch");
    dir = mkdtempSync(join(tmpdir(), "jarvis-e2e-watch-"));
  });
  afterAll(async () => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (t) await t.cleanup();
  });

  test("stays quiet while the check exits non-zero, then fires and hands back in the thread when it exits 0", async () => {
    const marker = join(dir, "ready");
    const db = openDatabase(":memory:");
    const watches = createWatchRepo(db);
    let now = 1_000;
    const turns: { channelId: string; threadTs: string; text: string }[] = [];
    let handedBack: () => void = () => {};
    const handBack = new Promise<void>((resolve) => {
      handedBack = resolve;
    });
    const watcher = createWatcher({
      watches,
      clock: () => now,
      check: createShellCheck(dir),
      runTurn: async (req) => {
        turns.push({ channelId: req.channelId, threadTs: req.threadTs, text: req.text });
        const res = await t.web.chat.postMessage({ channel: req.channelId, thread_ts: req.threadTs, text: req.text });
        t.track(res.ts);
        handedBack();
      },
      log: (m) => console.log(`  [watcher] ${m}`),
    });

    const note = "e2e watch: carry on with the e2e follow-up";
    const w = watches.add(
      { channelId: CHANNEL, threadTs: t.rootTs, slackUserId: t.botUserId, note, check: `test -f ${marker}`, everyMs: 1_000, deadlineAt: 10_000_000, createdAt: now },
      now,
    );

    await watcher.tick();
    expect(watches.get(w.id)?.state).toBe("waiting");
    expect(turns).toHaveLength(0);

    writeFileSync(marker, "ready\n");
    now += 5_000;
    await watcher.tick();
    await handBack;

    expect(watches.get(w.id)?.state).toBe("fired");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.threadTs).toBe(t.rootTs);
    expect(turns[0]?.text).toContain(note);

    const landed = await t.waitFor((all) => all.find((m) => m.ts !== t.rootTs && (m.text ?? "").includes(note)));
    console.log(`  watch case: fired, hand-back in thread ${landed?.thread_ts}`);
    expect(landed?.thread_ts).toBe(t.rootTs);

    // Fired means settled: another tick must not hand back a second time.
    now += 5_000;
    await watcher.tick();
    expect(turns).toHaveLength(1);
  }, 60_000);
});
