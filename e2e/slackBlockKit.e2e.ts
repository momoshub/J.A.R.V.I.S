/**
 * End-to-end: a reply with Block Kit, through the real stream code path
 * against real Slack.
 *
 * Opt-in, and not part of `bun test` or CI (the file is not a `*.test.ts`, and
 * it skips itself unless `JARVIS_E2E=1` and `SLACK_BOT_TOKEN` are set). Run it
 * with `bun run test:e2e`. It posts into a private test channel, under one
 * root message per run, reads the thread back and deletes what it posted.
 *
 * What it drives is `createHandler` with a scripted LLM and a real WebClient:
 * the real `createSlackStream`, `chat.startStream`/`appendStream`/`stopStream`,
 * the tidy-up rewrite and the plain-post fallbacks. Only the model is faked.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WebClient } from "@slack/web-api";
import { createHandler, type Incoming, type SlackAppConfig, type SlackClient } from "../src/infrastructure/slack/app.ts";
import { openDatabase } from "../src/infrastructure/db/client.ts";
import { createUserRepo } from "../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../src/infrastructure/db/messageRepo.ts";
import type { LlmPort } from "../src/application/ports.ts";

const TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const CHANNEL = process.env.JARVIS_E2E_CHANNEL ?? "";
const KEEP = process.env.JARVIS_E2E_KEEP === "1";
const enabled = process.env.JARVIS_E2E === "1" && TOKEN !== "" && CHANNEL !== "";

const cell = (text: string) => ({ type: "raw_text", text });
/** The live incident: a table whose header cell is empty (Slack needs 1+ char). */
const TABLE_EMPTY_CELL = JSON.stringify([
  {
    type: "table",
    rows: [
      [cell(""), cell("Qty"), cell("Status")],
      [cell("widget"), cell("3"), cell("ok")],
      [cell("gadget"), cell("12"), cell("late")],
    ],
  },
]);
/** `alert` is typed by the SDK and refused by Slack in a message: the degrade path. */
const ALERT = JSON.stringify([{ type: "alert", level: "warning", text: { type: "mrkdwn", text: "watch out for the refused block" } }]);

type SlackMessage = { ts?: string; text?: string; user?: string; bot_id?: string; blocks?: { type: string }[] };

describe.skipIf(!enabled)("Block Kit reply against real Slack", () => {
  const web = new WebClient(TOKEN);
  const posted: string[] = [];
  let rootTs = "";
  let botUserId = "";
  let teamId = "";
  let recipient = "";
  const seen = new Set<string>();

  const threadReplies = async (): Promise<SlackMessage[]> => {
    const res = await web.conversations.replies({ channel: CHANNEL, ts: rootTs, limit: 200 });
    return (res.messages ?? []) as SlackMessage[];
  };

  /** Drive one reply through the real handler and return the bot messages it left in the thread. */
  const reply = async (answer: string): Promise<SlackMessage[]> => {
    const db = openDatabase(":memory:");
    const users = createUserRepo(db);
    users.upsert({ slackId: recipient, role: "owner", displayName: "e2e", addedBy: "system", createdAt: 1 });
    let t = 1;
    // The model's text arrives in small deltas, so a fence spans several of them.
    const deltas = answer.match(/[\s\S]{1,7}/g) ?? [];
    const llm: LlmPort = {
      complete: async () => answer,
      stream: async (_p, sink) => {
        for (const delta of deltas) sink({ type: "text", delta });
        return answer;
      },
    };
    const config: SlackAppConfig = {
      botToken: TOKEN,
      appToken: "unused",
      streamUpdates: true,
      botName: "e2e",
      thinkingLabel: () => "thinking",
      thinkingDoneLabel: () => "done",
      commandPrefix: "//e2e",
      slashCommand: "/e2e",
      thinkingAfterMs: 60_000,
    };
    const handle = createHandler(
      config,
      { users, messages: createMessageRepo(db), llm, clock: () => t++, ownerSlackId: recipient },
      (m) => console.log(`  [handler] ${m}`),
    );
    const msg: Incoming = {
      channelId: CHANNEL,
      userId: recipient,
      teamId,
      text: "e2e prompt",
      threadTs: rootTs,
      messageTs: rootTs,
      client: web as unknown as SlackClient,
      say: async (m) => {
        const res = await web.chat.postMessage({
          channel: CHANNEL,
          text: m.text,
          thread_ts: m.thread_ts ?? rootTs,
          ...(m.blocks ? { blocks: m.blocks as never } : {}),
        });
        if (res.ts) posted.push(res.ts);
      },
    };
    await handle(msg);

    const fresh: SlackMessage[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      fresh.length = 0;
      for (const m of await threadReplies()) {
        if (!m.ts || m.ts === rootTs || seen.has(m.ts)) continue;
        if (m.user === botUserId || m.bot_id) fresh.push(m);
      }
      if (fresh.length > 0) break;
      await Bun.sleep(500);
    }
    for (const m of fresh) {
      if (m.ts) {
        seen.add(m.ts);
        posted.push(m.ts);
      }
    }
    return fresh;
  };

  const noFence = (m: SlackMessage) => {
    expect(m.text ?? "").not.toContain("```blockkit");
    expect(JSON.stringify(m.blocks ?? [])).not.toContain("```blockkit");
  };

  beforeAll(async () => {
    const auth = await web.auth.test();
    botUserId = auth.user_id ?? "";
    teamId = auth.team_id ?? "";
    recipient = process.env.JARVIS_E2E_USER ?? process.env.OWNER_SLACK_ID ?? botUserId;
    const root = await web.chat.postMessage({ channel: CHANNEL, text: `jarvis e2e run ${new Date().toISOString()} (deleted when done)` });
    rootTs = root.ts ?? "";
    expect(rootTs).not.toBe("");
    console.log(`  e2e root ${CHANNEL} ${rootTs}, bot ${botUserId}, team ${teamId}`);
  });

  afterAll(async () => {
    if (KEEP || !rootTs) return;
    for (const ts of [...new Set(posted)].reverse().concat(rootTs)) {
      await web.chat.delete({ channel: CHANNEL, ts }).catch((e: unknown) => console.log(`  cleanup ${ts}: ${e instanceof Error ? e.message : String(e)}`));
    }
  });

  test("a table with an empty cell arrives as ONE message holding a table block", async () => {
    const out = await reply(`Here is the stock:\n\`\`\`blockkit\n${TABLE_EMPTY_CELL}\n\`\`\`\nThat is all.`);
    console.log(`  table case: ${out.length} message(s), block types ${JSON.stringify(out.map((m) => (m.blocks ?? []).map((b) => b.type)))}`);
    expect(out).toHaveLength(1);
    const m = out[0] as SlackMessage;
    expect((m.blocks ?? []).some((b) => b.type === "table")).toBe(true);
    noFence(m);
  }, 60_000);

  test("a plain-text reply arrives as ONE message", async () => {
    const out = await reply("Just a sentence, nothing fancy.");
    console.log(`  plain case: ${out.length} message(s)`);
    expect(out).toHaveLength(1);
    const m = out[0] as SlackMessage;
    expect(m.text).toContain("Just a sentence, nothing fancy.");
    expect((m.blocks ?? []).some((b) => b.type === "table")).toBe(false);
    noFence(m);
  }, 60_000);

  test("a block Slack refuses degrades to its words: one message, no raw fence, the rest of the reply intact", async () => {
    const out = await reply(`Heads up:\n\`\`\`blockkit\n${ALERT}\n\`\`\`\nAfter the alert.`);
    console.log(`  refused-block case: ${out.length} message(s)`);
    expect(out).toHaveLength(1);
    const m = out[0] as SlackMessage;
    const shown = `${m.text ?? ""}${JSON.stringify(m.blocks ?? [])}`;
    expect(shown).toContain("watch out for the refused block");
    expect(shown).toContain("After the alert.");
    noFence(m);
  }, 60_000);
});
