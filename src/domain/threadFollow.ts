/**
 * Following a thread the bot itself started.
 *
 * Until now it answered two things: a DM, or an @-mention. That is right for a
 * channel it is a guest in, and wrong for a thread it opened - it posts a
 * summary, people reply underneath discussing it, and the bot sits there
 * deaf unless somebody remembers to tag it. The person who started the
 * conversation is the one expected to keep up with it.
 *
 * So a reply under a thread whose PARENT the bot posted is treated like a
 * message addressed to it. The ownership test is the parent's author and
 * nothing else: being mentioned earlier in a thread, or having replied in it,
 * does not make the thread the bot's. Otherwise one tag in a busy channel
 * would sign it up to narrate the rest of the day.
 *
 * Pure. Whether the parent is actually the bot's is a Slack lookup, done by
 * the transport and handed in.
 */

/** The slice of a Slack message this decision needs. */
export type FollowCandidate = {
  readonly subtype?: string;
  readonly bot_id?: string;
  readonly user?: string;
  readonly text?: string;
  readonly channel_type?: string;
  readonly ts: string;
  readonly thread_ts?: string;
};

/** Does this text tag the bot? A tagged message is the mention handler's. */
export const mentionsBot = (text: string, botUserId?: string): boolean =>
  !!botUserId && new RegExp(`<@${botUserId}(?:[|:][^>]*)?>`).test(text);

/**
 * Is this a message the bot should even consider following?
 *
 * Everything here is cheap and local. The expensive part - who wrote the
 * thread's parent - is only worth asking once this says yes.
 */
export const couldFollowThread = (m: FollowCandidate, botUserId?: string): boolean => {
  // Edits, joins, deletions and other subtypes are not somebody talking.
  if (m.subtype || m.bot_id) return false;
  if (!m.user || !m.text?.trim()) return false;
  // DMs already get answered; this is for channels.
  if (m.channel_type === "im") return false;
  // Only a REPLY, never the parent itself.
  if (!m.thread_ts || m.thread_ts === m.ts) return false;
  // Never itself, or it would answer its own follow-ups forever.
  if (botUserId && m.user === botUserId) return false;
  // A tagged message is handled by the mention event; following it here too
  // would answer the same message twice.
  return !mentionsBot(m.text, botUserId);
};

/**
 * Does this untagged thread message get an answer?
 *
 * Two routes in, and they are not the same decision. The bot follows a thread
 * it OPENED by default, which `follow_own_threads=off` turns off wholesale.
 * It also follows one somebody ASKED it to (`follow`), and that is a decision
 * about a single thread - so it outranks the blanket setting rather than
 * being swept away by it. Someone who turns off the default and then points
 * at one conversation means exactly what they said.
 *
 * `couldFollowThread` has already decided the message is eligible at all;
 * this only decides whose thread it is.
 */
export const shouldFollowThread = (opts: {
  /** Somebody ran `follow` on this thread. */
  readonly asked: boolean;
  /** The thread's parent was posted by the bot. */
  readonly ownThread: boolean;
  /** `follow_own_threads` is off. */
  readonly ownThreadsOff: boolean;
}): boolean => {
  if (opts.asked) return true;
  if (opts.ownThreadsOff) return false;
  return opts.ownThread;
};
