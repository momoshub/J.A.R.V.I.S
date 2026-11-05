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

/** A file shared on a Slack message. `urlPrivate` needs the bot token to fetch. */
export type SlackFile = {
  name: string;
  mimetype: string;
  /** Authenticated download url - not usable without the token. */
  urlPrivate: string;
  size?: number;
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
  /** Anything attached to the message: images, documents, snippets. */
  files?: SlackFile[];
};

/** A page of history plus the cursor to fetch the next (older) page. */
export type HistoryPage = {
  messages: SlackMessage[];
  /** Slack cursor for the next older page, or undefined when at the beginning. */
  nextCursor?: string;
};

/** Where a posted message ended up. */
export type PostedRef = { channel: string; ts: string };

/** A button on an interactive message. */
export type InteractiveAction = {
  actionId: string;
  label: string;
  /** Opaque payload handed back when it is pressed. */
  value: string;
  style?: "primary" | "danger";
};

/** One choice in a menu. Slack's limits are applied in the domain, not here. */
export type MenuOption = {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
};

/** Choices under a heading, so a long menu stays readable. */
export type MenuGroup = {
  readonly label: string;
  readonly options: readonly MenuOption[];
};

/** A picker plus optional one-click buttons, posted as one message. */
export type InteractiveMenu = {
  readonly select?: {
    readonly actionId: string;
    readonly placeholder: string;
    readonly groups: readonly MenuGroup[];
  };
  readonly actions?: readonly InteractiveAction[];
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
  /**
   * A clickable link to one message. `team.info` would give the workspace
   * domain directly but needs a scope this token does not have; this one works
   * with `chat:write`, so it is how a thread link gets built at all.
   */
  permalink?: (channel: string, ts: string) => Promise<string | undefined>;
  /** Edit one of the bot's own messages. */
  update: (channel: string, ts: string, text: string) => Promise<void>;
  /** Delete one of the bot's own messages. */
  remove: (channel: string, ts: string) => Promise<void>;
  /**
   * Post a message, optionally into a thread. Returns where it landed when the
   * transport knows, so a temporary notice can be taken down again.
   */
  post: (channel: string, text: string, threadTs?: string) => Promise<PostedRef | void>;
  /**
   * Open (or reuse) a DM with a user and post there. Returns where it landed,
   * so a message can later be found again - matching a reaction to it, say.
   */
  postDm: (userId: string, text: string) => Promise<PostedRef | undefined>;
  /**
   * DM a message with buttons on it. The transport owns how they are rendered;
   * callers only say what the buttons are and what they carry.
   */
  postDmInteractive: (
    userId: string,
    text: string,
    actions: readonly InteractiveAction[],
  ) => Promise<PostedRef | undefined>;
  /**
   * Post a message with buttons into a channel or thread, rather than a DM.
   * Used where the ask belongs in the conversation it came from - asking someone
   * for their own Claude token in the thread they ran the command in.
   */
  postInteractive: (
    channel: string,
    text: string,
    actions: readonly InteractiveAction[],
    threadTs?: string,
  ) => Promise<PostedRef | undefined>;
  /**
   * Post a message carrying a picker (and optionally buttons).
   *
   * Separate from `postInteractive` because a select is not a button: it has
   * grouped options and hands back a selection rather than a press, and the
   * one caller that wants both wants them in a single message.
   */
  postMenu: (
    channel: string,
    text: string,
    menu: InteractiveMenu,
    threadTs?: string,
  ) => Promise<PostedRef | undefined>;
  /** Replace an interactive message's buttons with settled text. */
  settleInteractive: (channel: string, ts: string, text: string) => Promise<void>;
  /** Add reactions to a message (tolerant of already-reacted / invalid names). Returns how many landed. */
  addReactions: (channel: string, ts: string, names: readonly string[]) => Promise<number>;
  /** The bot's own Slack user id, so it can recognise itself being tagged. */
  botUserId: () => Promise<string | undefined>;
  /** Resolve Slack display names for a set of user ids (cached, best-effort). */
  resolveNames: (ids: readonly string[]) => Promise<Record<string, string>>;
};
