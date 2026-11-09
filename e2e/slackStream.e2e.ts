/**
 * End-to-end: a streamed reply into a thread, against real Slack.
 *
 * Opt-in like `slackBlockKit.e2e.ts` (`JARVIS_E2E=1` + `SLACK_BOT_TOKEN`; see
 * `bun run test:e2e`). It drives the real `createSlackStream` over a real
 * `chat.startStream`/`appendStream`/`stopStream`, feeding it the model's text
 * in small deltas as the CLI would, and reads the thread back: the reply must
 * be ONE message holding the whole text, in the thread, not the channel root.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSlackStream, type Streamer } from "../src/infrastructure/slack/stream.ts";
import { CHANNEL, enabled, openThread, type E2eThread, type SlackMessage } from "./support.ts";

describe.skipIf(!enabled)("streaming a reply into a thread against real Slack", () => {
  let t: E2eThread;
  beforeAll(async () => {
    t = await openThread("stream");
  });
  afterAll(async () => {
    if (t) await t.cleanup();
  });

  test("start/append/stop leaves ONE message in the thread with the full text", async () => {
    const sentences = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} of the streamed e2e reply.`);
    const answer = sentences.join(" ");
    const stream = createSlackStream(
      () =>
        t.web.chatStream({
          channel: CHANNEL,
          thread_ts: t.rootTs,
          recipient_user_id: t.botUserId,
          recipient_team_id: t.teamId,
          task_display_mode: "timeline",
        }) as unknown as Streamer,
      (m) => console.log(`  [stream] ${m}`),
    );
    for (const delta of answer.match(/[\s\S]{1,9}/g) ?? []) stream.sink({ type: "text", delta });
    const ok = await stream.finish();
    expect(ok).toBe(true);
    t.track(stream.ts);

    const botMessages = await t.waitFor((all) => {
      const mine = all.filter((m) => m.ts !== t.rootTs && (m.user === t.botUserId || m.bot_id));
      return mine.length > 0 && mine.every((m) => (m.text ?? "").includes("Sentence number 12")) ? mine : undefined;
    });
    expect(botMessages).toBeDefined();
    const mine = botMessages as SlackMessage[];
    console.log(`  stream case: ${mine.length} message(s), ${mine[0]?.text?.length ?? 0} chars`);
    expect(mine).toHaveLength(1);
    const m = mine[0] as SlackMessage;
    expect(m.thread_ts).toBe(t.rootTs);
    for (const s of sentences) expect(m.text ?? "").toContain(s);
  }, 60_000);
});
