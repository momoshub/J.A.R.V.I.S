/**
 * How the dashboard names Slack things: always the name AND the id, never a
 * bare id. An id alone tells nobody who or where; a name alone cannot be
 * searched for or pasted into a command. Unresolved names say so rather than
 * falling back to the id twice.
 */

export type ConversationKind = "channel" | "group" | "im" | "mpim";

/** What `conversations.info` told us about one conversation. */
export type ConversationInfo = {
  readonly kind: ConversationKind;
  /** Channel name without `#`; absent for a DM. */
  readonly name?: string;
  /** The other person, for a DM. */
  readonly userId?: string;
};

const named = (name: string | undefined, id: string): string | undefined => {
  const n = name?.trim();
  return n && n !== id ? n : undefined;
};

/** `Kai (U0123)`, or `unknown (U0123)` when the name could not be found. */
export const userLabel = (id: string, name?: string): string =>
  id ? `${named(name, id) ?? "unknown"} (${id})` : "unknown";

/**
 * `#team-chat (C0TEAM00001)`, a DM as the person (`@Kai (D0123)`), a group DM
 * as such. `userName` is the DM partner's name, resolved separately.
 */
export const conversationLabel = (id: string, info?: ConversationInfo, userName?: string): string => {
  if (!info) return `unknown (${id})`;
  switch (info.kind) {
    case "im": {
      const who = info.userId ? named(userName, info.userId) : undefined;
      return who ? `@${who} (${id})` : `DM (${id})`;
    }
    case "mpim":
      return `group DM (${id})`;
    default: {
      const name = named(info.name, id);
      return name ? `#${name.replace(/^#/, "")} (${id})` : `unknown (${id})`;
    }
  }
};

const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

/** User ids mentioned as `<@U…>` in a message. */
export const mentionedIds = (text: string): string[] => [...new Set([...text.matchAll(MENTION)].map((m) => m[1]!))];

/** `<@U1>` -> `@Kai (U1)`, using labels already resolved (`userLabel` output). */
export const labelMentions = (text: string, labels: Readonly<Record<string, string>>): string =>
  text.replace(MENTION, (_m, id: string) => `@${labels[id] ?? userLabel(id)}`);
