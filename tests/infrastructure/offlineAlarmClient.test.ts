import { describe, expect, test } from "bun:test";
import type { WebClient } from "@slack/web-api";
import { createOfflineAlarmSlack } from "../../src/infrastructure/slack/offlineAlarmClient.ts";
import { offlineNotice, onlineNotice } from "../../src/domain/offlineAlarm.ts";
import { FOOTER_BLOCK_ID } from "../../src/domain/messageFooter.ts";

const client = (userId: string | undefined, messages: unknown[]) =>
  ({
    auth: { test: async () => ({ user_id: userId }) },
    conversations: { history: async () => ({ messages }) },
    chat: { scheduledMessages: { list: async () => ({ scheduled_messages: [{ id: "Q1" }, { text: "no id" }] }) } },
  }) as unknown as WebClient;

describe("offline alarm Slack client", () => {
  test("recent keeps only the bot's own messages", async () => {
    const s = createOfflineAlarmSlack(
      client("UBOT", [
        { ts: "1.1", user: "UBOT", blocks: [{ block_id: "x" }] },
        { ts: "2.2", user: "USOMEONE", blocks: [{ block_id: "x" }] },
        { ts: "3.3", user: "UBOT" },
      ]),
    );
    expect(await s.recent("C1")).toEqual([{ ts: "1.1", blocks: [{ block_id: "x" }] }, { ts: "3.3" }]);
  });

  test("no bot id is an error, never a filter that matches nothing forever", async () => {
    const s = createOfflineAlarmSlack(client(undefined, [{ ts: "1.1", user: "" }]));
    await expect(s.recent("C1")).rejects.toThrow(/no user id/);
  });

  test("a notice is signed, stamped when Slack will post it; its edit is stamped now", async () => {
    const calls: Record<string, unknown>[] = [];
    const c = {
      ...client("U", []),
      chat: {
        scheduleMessage: async (a: Record<string, unknown>) => (calls.push(a), { scheduled_message_id: "Q9" }),
        update: async (a: Record<string, unknown>) => void calls.push(a),
      },
    } as unknown as WebClient;
    const s = createOfflineAlarmSlack(c, () => 1_794_200_000_000);
    await s.schedule("C1", 1_794_123_692, offlineNotice(1_794_123_000_000));
    await s.update("C1", "1.1", onlineNotice(1_794_123_000_000, 1_794_200_000_000));
    const footers = calls.map((a) => (a.blocks as { block_id?: string; elements?: { text: string }[] }[]).at(-1));
    expect(footers.map((f) => f?.block_id)).toEqual([FOOTER_BLOCK_ID, FOOTER_BLOCK_ID]);
    expect(footers[0]?.elements?.[0]?.text).toStartWith("offline alarm · updated <!date^1794123692^");
    expect(footers[1]?.elements?.[0]?.text).toStartWith("offline alarm · updated <!date^1794200000^");
    // the notice's own block is still first, so it is still found by its id
    expect((calls[0]?.blocks as { block_id?: string }[])[0]?.block_id).toStartWith("jv-offline:");
  });

  test("scheduled drops entries with no id", async () => {
    expect(await createOfflineAlarmSlack(client("U", [])).scheduled("C1")).toEqual([{ id: "Q1" }]);
  });
});
