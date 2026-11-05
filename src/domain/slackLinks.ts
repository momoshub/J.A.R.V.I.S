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
