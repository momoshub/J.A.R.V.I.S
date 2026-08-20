/**
 * Core domain types for E.V.
 *
 * These are plain, framework free data shapes. Nothing here knows about Slack,
 * SQLite or Anthropic - the outer layers map to and from these.
 */

/** Role of a person that E.V. is allowed to talk to. */
export type UserRole = "owner" | "admin" | "member";

/** A Slack user that is permitted to interact with E.V. */
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

/** A single turn stored as E.V.'s memory of a conversation. */
export type StoredMessage = {
  readonly id: number;
  readonly channelId: string;
  readonly slackUserId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: number;
};

/** A turn to be persisted (no id/timestamp yet). */
export type NewMessage = Omit<StoredMessage, "id" | "createdAt">;

/** A message shaped for the LLM prompt. */
export type PromptMessage = {
  readonly role: MessageRole;
  readonly content: string;
};

/** A durable fact E.V. has learned, shown and edited from the dashboard. */
export type Learning = {
  readonly id: number;
  readonly content: string;
  readonly createdBy: string;
  readonly createdAt: number;
};

/** Editable pieces that shape E.V.'s system prompt. */
export type PromptContext = {
  /** Overridden base personality/rules; falls back to the built-in default. */
  readonly base?: string;
  readonly learnings: readonly string[];
};

/** Outcome of an access-control check. */
export type AccessDecision =
  | { readonly allowed: true; readonly user: AllowedUser }
  | { readonly allowed: false; readonly reason: string };
