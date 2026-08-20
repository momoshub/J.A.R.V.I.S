/**
 * Core domain types for the bot
 *
 * These are plain, framework free data shapes. Nothing here knows about Slack,
 * SQLite or Anthropic - the outer layers map to and from these.
 */

/**
 * Role of a person the bot answers to, in increasing privilege:
 * - pal: sandboxed, read-only tools in a fixed scratch dir, may use `review`
 * - executer: sandboxed, tools assigned from the control deck
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
