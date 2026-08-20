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

/** A page of history plus the cursor to fetch the next (older) page. */
export type HistoryPage = {
  messages: SlackMessage[];
  /** Slack cursor for the next older page, or undefined when at the beginning. */
  nextCursor?: string;
};

export type SlackAdminPort = {
  /** Conversations the bot is a member of (joined channels, DMs, groups), recent first. */
  listConversations: () => Promise<SlackConversation[]>;
  /**
   * A page of messages, oldest-last. Pass the previous page's `nextCursor` to
   * fetch the next (older) page - Slack paginates backward in time.
   */
  history: (channel: string, limit: number, cursor?: string) => Promise<HistoryPage>;
  /** Full thread for a root message, oldest first. */
  replies: (channel: string, threadTs: string) => Promise<SlackMessage[]>;
  /** Edit one of the bot's own messages. */
  update: (channel: string, ts: string, text: string) => Promise<void>;
  /** Delete one of the bot's own messages. */
  remove: (channel: string, ts: string) => Promise<void>;
  /** Post a message, optionally into a thread. */
  post: (channel: string, text: string, threadTs?: string) => Promise<void>;
  /** Add reactions to a message (tolerant of already-reacted / invalid names). Returns how many landed. */
  addReactions: (channel: string, ts: string, names: readonly string[]) => Promise<number>;
};
