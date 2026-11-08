import { describe, expect, test } from "bun:test";
import type { WebClient } from "@slack/web-api";
import { createOfflineAlarmSlack } from "../../src/infrastructure/slack/offlineAlarmClient.ts";

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

  test("scheduled drops entries with no id", async () => {
    expect(await createOfflineAlarmSlack(client("U", [])).scheduled("C1")).toEqual([{ id: "Q1" }]);
  });
});
