/**
 * Slack mention formatting.
 *
 * Slack sends mentions as opaque `<@U123>` tokens, so the model cannot tell who
 * is being referenced. Before feeding a message to the brain we annotate each
 * mention with the resolved display name: `<@U123>` -> `<@U123:Jarvis>`. The id
 * is preserved so the model can still reply with a plain `<@U123>` that notifies.
 */

/** Matches a plain `<@U123>` or piped `<@U123|name>` mention (not an annotated one). */
const MENTION_TOKEN = /<@([A-Z0-9]+)(?:\|[^>]+)?>/g;
/** Matches any mention form, including annotated `<@U123:Name>`. */
const ANY_MENTION = /<@[A-Z0-9]+(?::[^>]+|\|[^>]+)?>/g;

/** Unique user ids referenced by `<@...>` mentions in `text`. */
export const extractMentionIds = (text: string): string[] => {
  const ids = new Set<string>();
  for (const m of text.matchAll(MENTION_TOKEN)) if (m[1]) ids.add(m[1]);
  return [...ids];
};

/**
 * Rewrite each mention to `<@ID:Name>` using `resolve` (falls back to the bare
 * id when unknown). Already-annotated mentions are left untouched.
 */
export const annotateMentions = (text: string, resolve: (id: string) => string | undefined): string =>
  text.replace(MENTION_TOKEN, (_full, id: string) => {
    const name = resolve(id)?.trim();
    return name ? `<@${id}:${name}>` : `<@${id}>`;
  });

/**
 * The user id in a single mention token, in any of the forms one can arrive in:
 * plain `<@U123>`, piped `<@U123|name>`, annotated `<@U123:Name>`, or a bare id.
 *
 * Command arguments are parsed *after* annotation, so anything reading a
 * mentioned user has to understand the annotated form too - missing it means a
 * command silently reads as having no target at all.
 */
export const mentionedId = (token: string | undefined): string | undefined => {
  if (!token) return undefined;
  const m = token.match(/^<@([A-Z0-9]+)(?::[^>]*|\|[^>]*)?>$/);
  if (m?.[1]) return m[1];
  return /^[UW][A-Z0-9]+$/.test(token) ? token : undefined;
};

/** True if `text` has anything beyond mentions and whitespace. */
export const hasContent = (text: string): boolean => text.replace(ANY_MENTION, "").trim().length > 0;
