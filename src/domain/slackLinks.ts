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
