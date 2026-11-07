/**
 * Core domain types for the bot
 *
 * These are plain, framework free data shapes. Nothing here knows about Slack,
 * SQLite or Anthropic - the outer layers map to and from these.
 */

/**
 * Role of a person the bot answers to, in increasing privilege:
 * - pal: sandboxed, read-only tools in a fixed scratch dir, may use `review`
 * - executer: sandboxed, tools assigned from the control deck, plus code edits and PRs
 * - admin: full tool access, can manage users
 * - owner: full control, cannot be removed
 */
export type UserRole = "pal" | "executer" | "admin" | "owner";

/** A Slack user that is permitted to interact with the bot */
export type AllowedUser = {
  readonly slackId: string;
  readonly role: UserRole;
  /** Slack display name, best effort - may be empty until first seen. */
  readonly displayName: string;
  readonly addedBy: string;
  readonly createdAt: number;
};

/** Author of a stored message within a conversation. */
export type MessageRole = "user" | "assistant";

/** A single turn stored as the bot's memory of a conversation. */
export type StoredMessage = {
  readonly id: number;
  readonly channelId: string;
  readonly slackUserId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: number;
  /** Slack ts of the source message, when it came from one. Addressable: reactions. */
  readonly slackTs?: string;
  /** Thread the turn belongs to; the brain's memory window is scoped to it. */
  readonly threadTs?: string;
};

/** A turn to be persisted (no id/timestamp yet). */
export type NewMessage = Omit<StoredMessage, "id" | "createdAt">;

/** A message shaped for the LLM prompt. */
export type PromptMessage = {
  readonly role: MessageRole;
  readonly content: string;
  /** Slack id of who sent a user turn, so transcripts can attribute + tag them. */
  readonly speakerId?: string;
};

/** An earlier message the bot can act on, e.g. react to. */
export type Reactable = {
  readonly ts: string;
  /** Slack id of whoever sent it. */
  readonly speakerId: string;
  /** Short excerpt, so the model can tell the messages apart. */
  readonly excerpt: string;
};

/** A person present in the conversation that the bot may mention with a Slack tag. */
export type Participant = {
  readonly id: string;
  readonly name?: string;
};

/** A durable fact the bot has learned, shown and edited from the dashboard. */
export type Learning = {
  readonly id: number;
  readonly content: string;
  readonly createdBy: string;
  readonly createdAt: number;
};

/** Editable pieces that shape the bot's system prompt. */
export type PromptContext = {
  /** The bot's name; falls back to the built-in default. */
  readonly botName?: string;
  /** Overridden base personality/rules; falls back to the built-in default. */
  readonly base?: string;
  readonly learnings: readonly string[];
  /** The memory adapter, when one is configured; replaces `learnings`. */
  readonly adapter?: import("./adapter.ts").Adapter;
};

/** Outcome of an access-control check. */
export type AccessDecision =
  | { readonly allowed: true; readonly user: AllowedUser }
  | { readonly allowed: false; readonly reason: string };

/** The GitHub account the bot reviews as - the comment is posted in this name. */
export type Reviewer = {
  readonly login: string;
  /** Profile name, when the account has one set. */
  readonly name?: string;
};

/** An instruction for a workflow's worker, said to the front mid-task. */
export type WorkflowSteer = {
  /** Slack id of the person it came from. */
  readonly by: string;
  readonly text: string;
  readonly at: number;
};

/** One thing a workflow's worker posted, kept for the front's digest. */
export type WorkerReply = {
  readonly text: string;
  readonly at: number;
};

/** A long-running CLI session bound to one Slack thread. */
export type Workflow = {
  readonly id: number;
  readonly channelId: string;
  readonly threadTs: string;
  /** CLI session id; resumed on every turn after the first. */
  readonly sessionId: string;
  readonly task: string;
  readonly startedBy: string;
  readonly status: "active" | "stopped";
  readonly turns: number;
  /** Steps it has taken on its own since it was last steered by a human. */
  readonly autoTurns: number;
  /**
   * Who the next step runs as, when one is pending. Set when a turn asked to
   * carry on and cleared when that step starts, so a restart in between can
   * pick it back up.
   */
  readonly continueAs?: string;
  /** Bumped on each request, so a stale timer cannot start a second chain. */
  readonly continueSeq: number;
  /**
   * The front's own CLI session: the one that answers people in the thread
   * while the worker session above does the task. Unset until its first turn.
   */
  readonly frontSessionId?: string;
  /** Instructions the front passed on that the worker has not seen yet. */
  readonly steers: readonly WorkflowSteer[];
  /** The worker's last few replies, newest last, for the front's digest. */
  readonly workerReplies: readonly WorkerReply[];
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** Someone the bot does not know yet, waiting on the owner's verdict. */
export type AccessRequest = {
  readonly id: number;
  readonly slackUserId: string;
  readonly displayName: string;
  /** Where they spoke, so the answer reaches them there. */
  readonly channelId: string;
  readonly threadTs: string;
  /** What they said, quoted to the owner for context. */
  readonly asked: string;
  /** The DM the owner reacts on. */
  readonly noticeChannel: string;
  readonly noticeTs: string;
  readonly status: "pending" | "approved" | "rejected";
  readonly createdAt: number;
  readonly decidedAt?: number;
};

/** A command held until someone with authority approves it. */
export type CommandApproval = {
  readonly id: number;
  readonly slackUserId: string;
  readonly displayName: string;
  readonly channelId: string;
  readonly threadTs: string;
  /** The command line as it would have been typed. */
  readonly line: string;
  readonly noticeChannel: string;
  readonly noticeTs: string;
  readonly status: "pending" | "approved" | "rejected";
  readonly decidedBy?: string;
  readonly createdAt: number;
  readonly decidedAt?: number;
};

