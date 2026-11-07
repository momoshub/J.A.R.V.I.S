/**
 * What somebody is told when they write to a bot that is about to restart.
 *
 * A restart waits for running turns to finish, and while it waits it stops
 * reading the inbox so the wait can actually end. Nothing is lost - the rows
 * stay in the gateway and the next process picks them up - but from the
 * outside that is indistinguishable from being broken. Asked a question and
 * then "??", "??", "<@bot>???" into total silence, the only sane conclusion is
 * that it has died.
 *
 * So the silence gets one line. Once per thread, not once per message: a
 * person who is already repeating themselves does not need three apologies.
 */

/** Said once, in the thread that is waiting. */
export const drainNotice = (): string =>
  "⏸ I'm restarting, so I am not picking up new messages for a moment. Yours is saved and I will answer it as soon as I am back.";

/**
 * Where an inbox envelope was headed, so a waiting thread can be told.
 *
 * The stored body is Bolt's own `body` for the envelope, which for an events
 * API delivery is the event WRAPPER - `{ type: "event_callback", event: {...} }`
 * - with the event at the top level and no `payload` around it. Reading it as
 * `body.payload.event` matches nothing and notifies nobody, silently, which is
 * exactly how this would have shipped looking fine.
 *
 * Only message events have a thread worth answering in: an interactive press
 * or a slash command is its own thing, and a notice about a restart posted
 * into one would land where nobody is looking.
 */
export const envelopeThread = (
  body: Record<string, unknown>,
): { channel: string; threadTs?: string } | undefined => {
  const event = body.event as Record<string, unknown> | undefined;
  if (!event || event.type !== "message") return undefined;
  // The bot's own messages are not somebody waiting for an answer.
  if (event.bot_id || event.subtype === "bot_message") return undefined;
  const channel = typeof event.channel === "string" ? event.channel : "";
  if (!channel) return undefined;
  const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : undefined;
  return { channel, ...(threadTs ? { threadTs } : {}) };
};

/** One notice per thread, so repeated asks do not each get an apology. */
export const unnotified = (
  targets: readonly { channel: string; threadTs?: string }[],
  already: ReadonlySet<string>,
): { channel: string; threadTs?: string; key: string }[] => {
  const out: { channel: string; threadTs?: string; key: string }[] = [];
  const seen = new Set(already);
  for (const t of targets) {
    const key = `${t.channel}:${t.threadTs ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...t, key });
  }
  return out;
};
