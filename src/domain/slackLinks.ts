/**
 * Parse a Slack message permalink into its channel id and message ts.
 * e.g. https://team.slack.com/archives/C0123/p1787122692303399
 *      -> { channel: "C0123", ts: "1787122692.303399" }
 */
export type MessageRef = { channel: string; ts: string };

export const parseMessageLink = (url: string): MessageRef | undefined => {
  const m = url.match(/\/archives\/([A-Z0-9]+)\/p(\d{10,})/i);
  if (!m || !m[1] || !m[2]) return undefined;
  const digits = m[2];
  if (digits.length < 7) return undefined;
  const ts = `${digits.slice(0, digits.length - 6)}.${digits.slice(-6)}`;
  return { channel: m[1], ts };
};

/**
 * A Slack-shaped ts for a turn that no real message triggered (`mindful`,
 * `reply`). It must match nothing in the thread and sort after all of it: the
 * thread root's ts made the turn treat the root as its trigger, cut the
 * thread there, and drop the instruction it was actually started with.
 */
export const syntheticTs = (nowMs: number): string => (nowMs / 1000).toFixed(6);

/** Where `post` puts a message: a channel's top level (id known or still a name), or inside an existing thread. */
export type PostTarget =
  | { readonly kind: "channel"; readonly channel: string }
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "thread"; readonly channel: string; readonly threadTs: string };

const CHANNEL_ID = /^[CGD][A-Z0-9]{8,}$/;
/** A Slack channel id (public, private or DM; never a user id): what `post` accepts, and the only cross-channel write target of an owner's turn. */
export const isChannelId = (s: string): boolean => CHANNEL_ID.test(s);
const CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;

/**
 * Read the first argument of `post`: a Slack channel mention (`<#C123|name>`), a
 * channel id (`C123`, `#C123`), a channel name (`#name`), or a message/thread
 * permalink. A link means that thread (its `thread_ts` when it points at a reply,
 * else the message itself as the thread root), everything else is the top level.
 * A bare word without `#` is no target: it is more likely the first word of the text.
 */
export const parsePostTarget = (raw: string): PostTarget | undefined => {
  const arg = raw.trim().replace(/&amp;/g, "&");
  const mention = arg.match(/^<#([A-Z0-9]+)(?:\|[^>]*)?>$/);
  if (mention?.[1]) return CHANNEL_ID.test(mention[1]) ? { kind: "channel", channel: mention[1] } : undefined;
  const link = arg.replace(/^<|>$/g, "");
  if (/^https?:\/\//i.test(link)) {
    const ref = parseMessageLink(link);
    if (!ref) return undefined;
    return { kind: "thread", channel: ref.channel, threadTs: link.match(/[?&]thread_ts=(\d+\.\d+)/)?.[1] ?? ref.ts };
  }
  if (CHANNEL_ID.test(arg)) return { kind: "channel", channel: arg };
  const hashed = arg.replace(/^#/, "");
  if (!arg.startsWith("#")) return undefined;
  if (CHANNEL_ID.test(hashed)) return { kind: "channel", channel: hashed };
  const name = hashed.toLowerCase();
  return CHANNEL_NAME.test(name) ? { kind: "name", name } : undefined;
};
