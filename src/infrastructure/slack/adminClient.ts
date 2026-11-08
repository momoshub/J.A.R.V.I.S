/**
 * Slack admin adapter - implements `SlackAdminPort` over the Slack Web API using
 * the bot token. Resolves and caches the bot's own user id and display names so
 * the console can mark editable messages and render senders.
 */
import { WebClient } from "@slack/web-api";
import { splitForBlocks, toMrkdwn } from "../../domain/slackFormat.ts";
import { toBlockMessage } from "../../domain/blockKit.ts";
import { type MessageBlock, visibleText } from "../../domain/slackMessageText.ts";
import { footerBlock, footerLine, sectionChunks, signedSections, signedText, SIGNATURES, withFooter } from "../../domain/messageFooter.ts";
import type { SlackMember } from "../../domain/slackMembers.ts";
import { type FooterUsage, usageFooter } from "../../domain/usageFooter.ts";
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
  /**
   * Present on a message the bot streamed into. `text` is Slack's flattened
   * fallback and runs the tool cards together with the reply, so the blocks are
   * what says which part of it was a tool call.
   */
  blocks?: MessageBlock[];
  files?: { name?: string; mimetype?: string; url_private?: string; size?: number }[];
};

type RawMember = {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  profile?: { real_name?: string; display_name?: string; title?: string; email?: string; image_48?: string; image_72?: string };
};

const toMember = (m: RawMember): SlackMember => ({
  id: m.id ?? "",
  handle: m.name ?? "",
  realName: m.profile?.real_name || m.real_name || "",
  displayName: m.profile?.display_name ?? "",
  title: m.profile?.title ?? "",
  email: m.profile?.email ?? "",
  avatar: m.profile?.image_48 || m.profile?.image_72 || "",
  deleted: !!m.deleted,
  isBot: !!m.is_bot || !!m.is_app_user,
});

const MENTION = (botId: string) => new RegExp(`<@${botId}(?:\\|[^>]+)?>`);

/** Recency is enriched via one history call per conversation; keep it bounded. */
const RECENCY_CAP = 15;
const RECENCY_CONCURRENCY = 4;

/** Run `fn` over `items` in sequential batches of `n` to avoid API bursts. */
const mapPool = async <T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) {
    out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  }
  return out;
};

export const createSlackAdmin = (client: WebClient, clock: () => number = Date.now): SlackAdminPort => {
  const nameCache = new Map<string, string>();
  /** The grey signature line, stamped now: every post and edit carries one. */
  const footer = (by?: string, usage?: FooterUsage): string =>
    footerLine(by ?? SIGNATURES.jarvis, clock(), usage ? usageFooter(usage) : undefined);
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

  type RawConversation = {
    id?: string;
    name?: string;
    is_im?: boolean;
    is_mpim?: boolean;
    is_private?: boolean;
    user?: string;
  };

  const conversationName = async (c: RawConversation): Promise<SlackConversation> => {
    const kind: SlackConversation["kind"] = c.is_im
      ? "im"
      : c.is_mpim
        ? "mpim"
        : c.is_private
          ? "group"
          : "channel";
    const name = c.is_im ? `@${await userName(c.user)}` : c.is_mpim ? "group dm" : `#${c.name ?? c.id}`;
    return { id: c.id ?? "", name, kind, lastActive: 0 };
  };

  /** Latest message time (epoch ms) in a conversation, 0 if unknown/empty. */
  const latestActivity = async (channel: string): Promise<number> => {
    try {
      const h = (await client.conversations.history({ channel, limit: 1 })) as { messages?: RawMessage[] };
      const ts = h.messages?.[0]?.ts;
      return ts ? Math.floor(Number(ts) * 1000) : 0;
    } catch {
      return 0;
    }
  };

  const toMessage = async (m: RawMessage, botId: string): Promise<SlackMessage> => {
    const userId = m.user ?? "";
    // What the message SAYS - a streamed reply's fallback text carries the
    // bot's own tool-card titles, which nobody in Slack ever sees and which the
    // bot would otherwise read back as words it had written.
    const text = visibleText(m);
    return {
      ts: m.ts ?? "",
      userId,
      userName: m.bot_id && !m.user ? "bot" : await userName(userId),
      text,
      replyCount: m.reply_count ?? 0,
      threadTs: m.thread_ts,
      own: userId === botId,
      mentionsBot: botId ? MENTION(botId).test(text) : false,
      ...(m.files && m.files.length > 0
        ? {
            files: m.files.map((f) => ({
              name: f.name ?? "file",
              mimetype: f.mimetype ?? "application/octet-stream",
              urlPrivate: f.url_private ?? "",
              ...(typeof f.size === "number" ? { size: f.size } : {}),
            })),
          }
        : {}),
    };
  };

  return {
    botUserId: async () => {
      try {
        return (await getBotUserId()) || undefined;
      } catch {
        return undefined;
      }
    },

    listConversations: async () => {
      // users.conversations returns only conversations the bot is a MEMBER of
      // (joined channels, private groups, DMs, group DMs) - not every public channel.
      const res = (await client.users.conversations({
        types: "public_channel,private_channel,im,mpim",
        exclude_archived: true,
        limit: 200,
      })) as { channels?: RawConversation[] };
      const raw = (res.channels ?? []).filter((c) => c.id);
      // Enrich only the first N with a recency probe (bounded concurrency, fail-fast
      // so a throttled probe never blocks the list); the rest keep lastActive 0.
      const enriched = await mapPool(raw.slice(0, RECENCY_CAP), RECENCY_CONCURRENCY, async (c) => ({
        ...(await conversationName(c)),
        lastActive: await latestActivity(c.id!),
      }));
      const rest = await Promise.all(raw.slice(RECENCY_CAP).map(conversationName));
      return [...enriched, ...rest].sort((a, b) => b.lastActive - a.lastActive);
    },

    history: async (channel, limit, cursor) => {
      const botId = await getBotUserId();
      const res = (await client.conversations.history({
        channel,
        limit,
        ...(cursor ? { cursor } : {}),
      })) as { messages?: RawMessage[]; response_metadata?: { next_cursor?: string } };
      const msgs = (res.messages ?? []).filter((m) => m.ts && (m.text || m.bot_id));
      const mapped = await Promise.all(msgs.map((m) => toMessage(m, botId)));
      // API returns newest-first; show oldest-first. Cursor pages go further back.
      return { messages: mapped.reverse(), nextCursor: res.response_metadata?.next_cursor || undefined };
    },

    replies: async (channel, threadTs) => {
      const botId = await getBotUserId();
      const res = (await client.conversations.replies({ channel, ts: threadTs })) as { messages?: RawMessage[] };
      return Promise.all((res.messages ?? []).map((m) => toMessage(m, botId)));
    },

    permalink: async (channel, ts) => {
      try {
        const res = (await client.chat.getPermalink({ channel, message_ts: ts })) as { permalink?: string };
        return res.permalink;
      } catch {
        return undefined; // a link is a convenience, never a reason to fail
      }
    },

    update: async (channel, ts, text, by) => {
      // Blocks every time: an edit that sent only text would keep the old
      // blocks on screen, footer and all, and change nothing anyone sees.
      // A refused markdown block is retried as sections; a refused rewrite
      // (a stopped stream's block_mismatch, say) still edits the words,
      // text-only, as before.
      const line = footer(by);
      await client.chat
        .update({ channel, ts, ...signedText(text, line) })
        .catch(() => client.chat.update({ channel, ts, ...signedSections(text, line) }))
        .catch(() => client.chat.update({ channel, ts, text }));
    },

    remove: async (channel, ts) => {
      await client.chat.delete({ channel, ts });
    },

    lookup: async (channel, ts) => {
      // `replies` answers for a parent and for a reply alike; `history` is the
      // fallback for a plain message in a channel the replies call refuses.
      const fromReplies = async () =>
        ((await client.conversations.replies({ channel, ts, inclusive: true, limit: 1 })) as {
          messages?: RawMessage[];
        }).messages ?? [];
      const fromHistory = async () =>
        ((await client.conversations.history({ channel, latest: ts, inclusive: true, limit: 1 })) as {
          messages?: RawMessage[];
        }).messages ?? [];
      const found =
        (await fromReplies().catch(() => [])).find((m) => m.ts === ts) ??
        (await fromHistory().catch(() => [])).find((m) => m.ts === ts);
      if (!found?.ts) return undefined;
      return {
        ts: found.ts,
        userId: found.user,
        threadTs: found.thread_ts,
        broadcast: found.subtype === "thread_broadcast",
        text: found.text ?? "",
      };
    },

    broadcast: async (channel, ts) => {
      // No content: the typed args insist on some, but Slack keeps the
      // message as it is and only flips it into the channel.
      await client.apiCall("chat.update", { channel, ts, reply_broadcast: true });
    },

    unbroadcast: async (channel, ts) => {
      // Undocumented, but it is what the client's "Remove from channel" sends:
      // the channel copy goes, the thread reply stays with the same ts.
      await client.apiCall("chat.delete", { channel, ts, broadcast_delete: true });
    },

    post: async (channel, text, threadTs, by, usage) => {
      const thread = threadTs ? { thread_ts: threadTs } : {};
      const line = footer(by, usage);
      const rich = toBlockMessage(text, toMrkdwn);
      // A Block Kit reply that carries its own words falls back to those, not its JSON.
      const body = rich?.plain ?? toMrkdwn(text);
      // Signed in a markdown block, which Slack never folds behind "Show
      // more"; refused, the same as sections; refused again, the words bare.
      const bare = () => client.chat.postMessage({ channel, text: body, ...thread });
      const sections = () => client.chat.postMessage({ channel, ...signedSections(body, line), ...thread }).catch(bare);
      const plain = () => client.chat.postMessage({ channel, ...signedText(body, line), ...thread }).catch(sections);
      // A block Slack refuses falls back to the plain post rather than losing the message.
      const posted = (await (rich
        ? client.chat.postMessage({ channel, ...rich, blocks: withFooter(rich.blocks, line), ...thread }).catch(plain)
        : plain())) as {
        ts?: string;
      };
      return posted.ts ? { channel, ts: posted.ts } : undefined;
    },

    postDm: async (userId, text, by) => {
      const open = (await client.conversations.open({ users: userId })) as { channel?: { id?: string } };
      const channel = open.channel?.id;
      if (!channel) return undefined;
      const body = toMrkdwn(text);
      const posted = (await client.chat
        .postMessage({ channel, ...signedText(body, footer(by)) })
        .catch(() => client.chat.postMessage({ channel, text: body }))) as { ts?: string };
      return posted.ts ? { channel, ts: posted.ts } : undefined;
    },

    postDmInteractive: async (userId, text, actions, by) => {
      const open = (await client.conversations.open({ users: userId })) as { channel?: { id?: string } };
      const channel = open.channel?.id;
      if (!channel) return undefined;
      const posted = (await client.chat.postMessage({
        channel,
        text,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: toMrkdwn(text) } },
          {
            type: "actions",
            elements: actions.map((a) => ({
              type: "button",
              action_id: a.actionId,
              text: { type: "plain_text", text: a.label },
              value: a.value,
              ...(a.style ? { style: a.style } : {}),
            })),
          },
          footerBlock(footer(by)),
        ],
      })) as { ts?: string };
      return posted.ts ? { channel, ts: posted.ts } : undefined;
    },

    postInteractive: async (channel, text, actions, threadTs, by) => {
      const posted = (await client.chat.postMessage({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: toMrkdwn(text) } },
          {
            type: "actions",
            elements: actions.map((a) => ({
              type: "button",
              action_id: a.actionId,
              text: { type: "plain_text", text: a.label },
              value: a.value,
              ...(a.style ? { style: a.style } : {}),
            })),
          },
          footerBlock(footer(by)),
        ],
      })) as { ts?: string };
      return posted.ts ? { channel, ts: posted.ts } : undefined;
    },

    postMenu: async (channel, text, menu, threadTs, by) => {
      const elements: Record<string, unknown>[] = [];
      if (menu.select && menu.select.groups.length > 0) {
        elements.push({
          type: "static_select",
          action_id: menu.select.actionId,
          placeholder: { type: "plain_text", text: menu.select.placeholder },
          option_groups: menu.select.groups.map((g) => ({
            label: { type: "plain_text", text: g.label },
            options: g.options.map((o) => ({
              text: { type: "plain_text", text: o.label },
              value: o.value,
              ...(o.description ? { description: { type: "plain_text", text: o.description } } : {}),
            })),
          })),
        });
      }
      for (const a of menu.actions ?? []) {
        elements.push({
          type: "button",
          action_id: a.actionId,
          text: { type: "plain_text", text: a.label },
          value: a.value,
          ...(a.style ? { style: a.style } : {}),
        });
      }
      const posted = (await client.chat.postMessage({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        // The SDK's Block union does not describe option_groups; the shape is
        // Slack's documented one and is built right above.
        blocks: [
          // One section per chunk: Slack rejects a section over 3000 chars and
          // takes the whole message down with it.
          ...splitForBlocks(text).map((chunk) => ({
            type: "section",
            text: { type: "mrkdwn", text: toMrkdwn(chunk) },
          })),
          ...(elements.length > 0 ? [{ type: "actions", elements }] : []),
          footerBlock(footer(by)),
        ] as never,
      })) as { ts?: string };
      return posted.ts ? { channel, ts: posted.ts } : undefined;
    },

    settleInteractive: async (channel, ts, text, by) => {
      // Drop the buttons so a decided request cannot be clicked again.
      await client.chat
        .update({ channel, ts, ...signedText(text, footer(by)) })
        // Refused: the text as unsigned sections (still no buttons), and
        // failing that a text-only edit, so at least the words change.
        .catch(() =>
          client.chat.update({
            channel,
            ts,
            text: text || " ",
            blocks: sectionChunks(text).map((chunk) => ({ type: "section", text: { type: "mrkdwn", text: chunk } })),
          }),
        )
        .catch(() => client.chat.update({ channel, ts, text }));
    },

    addReactions: async (channel, ts, names) => {
      let landed = 0;
      for (const name of names) {
        try {
          await client.reactions.add({ channel, timestamp: ts, name });
          landed += 1;
        } catch {
          // already reacted, unknown emoji, or too many reactions - skip and continue
        }
      }
      return landed;
    },

    conversationInfo: async (id) => {
      try {
        const res = (await client.conversations.info({ channel: id })) as { channel?: RawConversation };
        const c = res.channel;
        if (!c) return undefined;
        const kind = c.is_im ? "im" : c.is_mpim ? "mpim" : c.is_private ? "group" : "channel";
        return { kind, ...(c.name ? { name: c.name } : {}), ...(c.user ? { userId: c.user } : {}) };
      } catch {
        return undefined;
      }
    },

    listMembers: async (cursor) => {
      const res = (await client.users.list({ limit: 200, ...(cursor ? { cursor } : {}) })) as {
        members?: RawMember[];
        response_metadata?: { next_cursor?: string };
      };
      return {
        members: (res.members ?? []).filter((m) => m.id).map(toMember),
        ...(res.response_metadata?.next_cursor ? { nextCursor: res.response_metadata.next_cursor } : {}),
      };
    },

    resolveNames: async (ids) => {
      const entries = await Promise.all(ids.map(async (id) => [id, await userName(id)] as const));
      return Object.fromEntries(entries);
    },
  };
};
