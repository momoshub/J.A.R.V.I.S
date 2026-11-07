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
export const couldFollowThread = (m: FollowCandidate, botUserId?: string): boolean =>
  followSkipReason(m, botUserId) === undefined;

/**
 * Whether a message subtype is still a person talking. A message with files
 * attached arrives as `file_share`, and it is as much a message as plain text:
 * dropping it lost every reply that carried a screenshot.
 */
export const isSpeech = (subtype?: string): boolean => !subtype || subtype === "file_share";

/**
 * Why a message is not even a follow candidate, or undefined when it is.
 *
 * The same checks as `couldFollowThread`, named, so a skip can be logged with
 * its reason instead of vanishing. A silent skip and an event Slack never
 * delivered look identical in the logs otherwise.
 */
export const followSkipReason = (m: FollowCandidate, botUserId?: string): string | undefined => {
  // Edits, joins, deletions and other subtypes are not somebody talking.
  if (!isSpeech(m.subtype)) return `subtype:${m.subtype}`;
  if (m.bot_id) return "bot";
  if (!m.user || !m.text?.trim()) return "empty";
  // DMs already get answered; this is for channels.
  if (m.channel_type === "im") return "dm";
  // Only a REPLY, never the parent itself.
  if (!m.thread_ts || m.thread_ts === m.ts) return "not-a-reply";
  // Never itself, or it would answer its own follow-ups forever.
  if (botUserId && m.user === botUserId) return "self";
  // A tagged message is handled by the mention event; following it here too
  // would answer the same message twice.
  if (mentionsBot(m.text, botUserId)) return "tagged";
  return undefined;
};

/**
 * Is this thread a conversation between the bot and one person?
 *
 * Somebody who tagged it once and then keeps talking with nobody else in the
 * thread is plainly still talking TO it. Making them tag it on every line is
 * friction for nothing. The bot must have replied at least once, so a thread
 * it has never touched is not claimed, and a second human ends it: from then
 * on it is a conversation the bot is a guest in.
 *
 * `participants` is everyone who has written in the thread, parent included;
 * the current author is added here because Slack may not have counted their
 * message yet.
 */
export const isOneOnOneThread = (opts: {
  readonly participants: readonly string[];
  readonly author: string;
  readonly botUserId: string;
}): boolean => {
  if (!opts.participants.includes(opts.botUserId)) return false;
  const humans = new Set([...opts.participants, opts.author]);
  humans.delete(opts.botUserId);
  return humans.size === 1;
};

/**
 * Is this thread still one person talking to the bot, so it should start
 * following it for good?
 *
 * Unlike `isOneOnOneThread`, the bot need not have replied yet: this runs as
 * the first tagged message comes in, before there is a reply. Once followed
 * the thread stays followed when others join - only an explicit "off" ends it.
 */
export const startsAutoFollow = (opts: {
  readonly participants: readonly string[];
  readonly author: string;
  readonly botUserId: string;
}): boolean => {
  const humans = new Set([...opts.participants, opts.author]);
  humans.delete(opts.botUserId);
  return humans.size === 1;
};

/** The owner's reaction that switches following off in a thread, silently. */
export const FOLLOW_OFF_REACTION = "rock";

/** Does this reaction (skin tone and all) switch following off? */
export const isFollowOffReaction = (reaction: string): boolean =>
  (reaction.split("::")[0] ?? reaction) === FOLLOW_OFF_REACTION;

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
 * A thread that is just the bot and one person is followed too, always: the
 * blanket setting is about threads it opened, not about someone mid-chat
 * with it.
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
  /** Only the bot and one person have written in the thread. */
  readonly oneOnOne?: boolean;
  /** Following was switched off here, which outranks every automatic route. */
  readonly optedOut?: boolean;
}): boolean => {
  if (opts.asked) return true;
  if (opts.optedOut) return false;
  if (opts.oneOnOne) return true;
  if (opts.ownThreadsOff) return false;
  return opts.ownThread;
};

/**
 * The follow decision with its reason, for the log line.
 *
 * Same answer as `shouldFollowThread`; the reason says which route let it in,
 * or why none did.
 */
export const followVerdict = (opts: Parameters<typeof shouldFollowThread>[0]): { follow: boolean; why: string } => {
  if (opts.asked) return { follow: true, why: "asked" };
  if (opts.optedOut) return { follow: false, why: "opted-out" };
  if (opts.oneOnOne) return { follow: true, why: "one-on-one" };
  if (opts.ownThreadsOff) return { follow: false, why: "own-threads-off" };
  return opts.ownThread ? { follow: true, why: "own-thread" } : { follow: false, why: "not-ours" };
};
