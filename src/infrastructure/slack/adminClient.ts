/**
 * Slack admin adapter - implements `SlackAdminPort` over the Slack Web API using
 * the bot token. Resolves and caches the bot's own user id and display names so
 * the console can mark editable messages and render senders.
 */
import { WebClient } from "@slack/web-api";
import type {
  SlackAdminPort,
  SlackConversation,
  SlackMessage,
} from "../../application/slackAdmin.ts";

type RawMessage = {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
  reply_count?: number;
  thread_ts?: string;
};

const MENTION = (botId: string) => new RegExp(`<@${botId}(?:\\|[^>]+)?>`);

export const createSlackAdmin = (client: WebClient): SlackAdminPort => {
  const nameCache = new Map<string, string>();
  let botUserId: string | undefined;

  const getBotUserId = async (): Promise<string> => {
    if (botUserId) return botUserId;
    const auth = (await client.auth.test()) as { user_id?: string };
    botUserId = auth.user_id ?? "";
    return botUserId;
  };

  const userName = async (userId: string | undefined): Promise<string> => {
    if (!userId) return "unknown";
    const cached = nameCache.get(userId);
    if (cached) return cached;
    try {
      const res = (await client.users.info({ user: userId })) as {
        user?: { profile?: { display_name?: string; real_name?: string }; real_name?: string; name?: string };
      };
      const p = res.user?.profile;
      const name = p?.display_name || p?.real_name || res.user?.real_name || res.user?.name || userId;
      nameCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  };

  const conversationName = async (c: {
    id?: string;
    name?: string;
    is_im?: boolean;
    is_mpim?: boolean;
    is_private?: boolean;
    user?: string;
  }): Promise<SlackConversation> => {
    const kind: SlackConversation["kind"] = c.is_im
      ? "im"
      : c.is_mpim
        ? "mpim"
        : c.is_private
          ? "group"
          : "channel";
    const name = c.is_im ? `@${await userName(c.user)}` : `#${c.name ?? c.id}`;
    return { id: c.id ?? "", name, kind };
  };

  const toMessage = async (m: RawMessage, botId: string): Promise<SlackMessage> => {
    const userId = m.user ?? "";
    return {
      ts: m.ts ?? "",
      userId,
      userName: m.bot_id && !m.user ? "bot" : await userName(userId),
      text: m.text ?? "",
      replyCount: m.reply_count ?? 0,
      threadTs: m.thread_ts,
      own: userId === botId,
      mentionsBot: botId ? MENTION(botId).test(m.text ?? "") : false,
    };
  };

  return {
    listConversations: async () => {
      const res = (await client.conversations.list({
        types: "public_channel,private_channel,im,mpim",
        exclude_archived: true,
        limit: 200,
      })) as { channels?: Parameters<typeof conversationName>[0][] };
      const list = await Promise.all((res.channels ?? []).map(conversationName));
      return list.filter((c) => c.id);
    },

    history: async (channel, limit) => {
      const botId = await getBotUserId();
      const res = (await client.conversations.history({ channel, limit })) as { messages?: RawMessage[] };
      const msgs = (res.messages ?? []).filter((m) => m.ts && (m.text || m.bot_id));
      const mapped = await Promise.all(msgs.map((m) => toMessage(m, botId)));
      return mapped.reverse(); // API returns newest-first; show oldest-first
    },

    replies: async (channel, threadTs) => {
      const botId = await getBotUserId();
      const res = (await client.conversations.replies({ channel, ts: threadTs })) as { messages?: RawMessage[] };
      return Promise.all((res.messages ?? []).map((m) => toMessage(m, botId)));
    },

    update: async (channel, ts, text) => {
      await client.chat.update({ channel, ts, text });
    },

    remove: async (channel, ts) => {
      await client.chat.delete({ channel, ts });
    },

    post: async (channel, text, threadTs) => {
      await client.chat.postMessage({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) });
    },
  };
};
