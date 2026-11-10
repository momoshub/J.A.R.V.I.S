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
import { VISIBLE_STEP_SLOTS, createSlackStream, type Streamer } from "../src/infrastructure/slack/stream.ts";
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

  test("a long run of steps holds five cards: the latest steps, a running one never replaced", async () => {
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
    stream.sink({ type: "tool", id: "slow", title: "Slow step", details: "log at: l.jsonl - line 0", status: "in_progress" });
    for (let i = 1; i <= 9; i++) {
      stream.sink({ type: "tool", id: `s${i}`, title: `Step ${i}`, details: `log at: l.jsonl - line ${i}`, status: "in_progress" });
      stream.sink({ type: "tool", id: `s${i}`, title: `Step ${i}`, status: "complete" });
    }
    stream.sink({ type: "tool", id: "nolog", title: "Step without a log", status: "in_progress" });
    stream.sink({ type: "text", delta: "Done with the steps." });
    // Left in progress on purpose: they must still be on screen when the stream stops.
    const ok = await stream.finish();
    expect(ok).toBe(true);
    t.track(stream.ts);

    type Card = { type: string; task_id?: string; title?: string; status?: string; details?: { elements?: { elements?: { text?: string }[] }[] } };
    const cards = await t.waitFor((all) => {
      const mine = all.filter((m) => m.ts === stream.ts);
      const found = (mine[0]?.blocks ?? []).filter((b) => b.type === "task_card") as Card[];
      return found.length > 0 ? found : undefined;
    });
    expect(cards).toBeDefined();
    const shown = (cards as Card[]).map((c) => ({
      title: c.title,
      details: c.details?.elements?.[0]?.elements?.[0]?.text,
    }));
    console.log(`  step cards: ${shown.map((c) => c.title).join(" | ")}`);
    const titles = shown.map((c) => c.title);
    // five slots: the slow step still running, the step with no log line, and the three latest finished
    expect(titles).toHaveLength(VISIBLE_STEP_SLOTS);
    expect(titles).toContain("Slow step · log line 0");
    expect(titles).toContain("Step without a log");
    for (const n of [1, 2, 3, 4, 5, 6]) expect(titles.some((t) => t?.startsWith(`Step ${n} `))).toBe(false);
    // a reused card carries its own log line, never the one it replaced
    for (const n of [7, 8, 9]) expect(titles).toContain(`Step ${n} · log line ${n}`);
    // Slack appends details, so a card holds the pointer once - and never another step's line
    for (const c of shown) expect(c.details).toBe("log at: l.jsonl");
  }, 90_000);
});
