/**
 * Slack side of the offline alarm (application/offlineAlarm.ts), on the bot token.
 * Scheduled messages are per token, so the list only ever holds the bot's own.
 */
import type { KnownBlock, WebClient } from "@slack/web-api";
import type { ChannelMessage, OfflineAlarmSlack, ScheduledMessage } from "../../application/offlineAlarm.ts";
import type { AlarmMessage } from "../../domain/offlineAlarm.ts";

/**
 * How far back to look for a notice Slack posted while we were gone. Enough
 * for a channel of its own; in a busy one a notice can scroll past it.
 */
const RECENT_LIMIT = 50;

const blocks = (msg: AlarmMessage): KnownBlock[] => msg.blocks.map((b) => ({ ...b, text: { ...b.text } }));

/**
 * Wants its own client with a timeout: the shared one has none, and a request
 * stalled on a half-open socket would hold every later tick until the 3-minute
 * lead ran out and the alarm fired while online.
 */
export const createOfflineAlarmSlack = (client: WebClient): OfflineAlarmSlack => {
  let botUserId: string | undefined;
  const me = async (): Promise<string> => {
    if (botUserId) return botUserId;
    const id = ((await client.auth.test()) as { user_id?: string }).user_id;
    if (!id) throw new Error("auth.test returned no user id");
    botUserId = id;
    return id;
  };

  return {
    schedule: async (channel, postAtSecs, msg) => {
      const res = (await client.chat.scheduleMessage({
        channel,
        post_at: postAtSecs,
        text: msg.text,
        blocks: blocks(msg),
      })) as { scheduled_message_id?: string };
      if (!res.scheduled_message_id) throw new Error("chat.scheduleMessage returned no id");
      return res.scheduled_message_id;
    },
    scheduled: async (channel) => {
      const res = (await client.chat.scheduledMessages.list({ channel })) as {
        scheduled_messages?: { id?: string; text?: string }[];
      };
      return (res.scheduled_messages ?? []).flatMap((s): ScheduledMessage[] =>
        s.id ? [{ id: s.id, ...(s.text !== undefined ? { text: s.text } : {}) }] : [],
      );
    },
    unschedule: async (channel, id) => {
      await client.chat.deleteScheduledMessage({ channel, scheduled_message_id: id });
    },
    recent: async (channel) => {
      const self = await me();
      const res = (await client.conversations.history({ channel, limit: RECENT_LIMIT })) as {
        messages?: { ts?: string; user?: string; blocks?: unknown[] }[];
      };
      return (res.messages ?? []).flatMap((m): ChannelMessage[] =>
        m.ts && m.user === self ? [{ ts: m.ts, ...(m.blocks ? { blocks: m.blocks } : {}) }] : [],
      );
    },
    update: async (channel, ts, msg) => {
      await client.chat.update({ channel, ts, text: msg.text, blocks: blocks(msg) });
    },
  };
};
