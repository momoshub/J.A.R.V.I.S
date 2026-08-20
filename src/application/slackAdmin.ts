/**
 * Slack admin port - the operations the dashboard "Console" needs to manage the
 * bot's own Slack presence (the web port of Jarvis's terminal message manager).
 *
 * Concrete implementation lives in infrastructure and wraps the Slack Web API
 * with the bot token; use cases and the dashboard depend only on this shape.
 */

export type SlackConversation = {
  id: string;
  name: string;
  kind: "channel" | "group" | "im" | "mpim";
  /** epoch ms of the latest message, for recency sorting (0 if unknown). */
  lastActive: number;
};

export type SlackMessage = {
  ts: string;
  userId: string;
  userName: string;
  text: string;
  replyCount: number;
  threadTs?: string;
  /** authored by our own bot user (editable/deletable) */
  own: boolean;
  /** text @-mentions our bot */
  mentionsBot: boolean;
};

export type SlackAdminPort = {
  /** Conversations the bot is a member of (joined channels, DMs, groups), recent first. */
  listConversations: () => Promise<SlackConversation[]>;
  /** Recent messages in a conversation, newest last. */
  history: (channel: string, limit: number) => Promise<SlackMessage[]>;
  /** Full thread for a root message, oldest first. */
  replies: (channel: string, threadTs: string) => Promise<SlackMessage[]>;
  /** Edit one of the bot's own messages. */
  update: (channel: string, ts: string, text: string) => Promise<void>;
  /** Delete one of the bot's own messages. */
  remove: (channel: string, ts: string) => Promise<void>;
  /** Post a message, optionally into a thread. */
  post: (channel: string, text: string, threadTs?: string) => Promise<void>;
};
