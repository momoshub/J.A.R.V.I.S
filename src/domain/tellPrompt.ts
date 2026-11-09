/**
 * The turn `tell` starts in another thread's session.
 *
 * Cross-session talk stays out of Slack: the relayed message is never posted,
 * and the session that receives it is told not to answer it there either. The
 * turn runner posts whatever the turn ends with, so the way to say nothing is
 * to end with the sentinel, which `isSilenceNote` drops.
 */

/** What a steer turn ends with when it has nothing for the humans in the thread. */
export const NO_REPLY = "NO_REPLY";

/** Marks the turn as an internal steer, so the session knows it is not a person typing. */
export const TELL_PREFIX = "[tell from another thread]";

export const tellPrompt = (senderId: string, message: string): string =>
  `${TELL_PREFIX} <@${senderId}> sent this from another thread's session. It is an internal steer, not a message from anyone in this thread, and nobody here can see it.

${message}

- Act on it. Do NOT acknowledge it or reply to it in Slack: no "got it", "on it", "done" or restating what you were told.
- Post in this thread only when the work itself produces something for the people here, such as the result that was asked for.
- If the only thing you would say is an acknowledgement, post nothing: end the turn with the single word ${NO_REPLY} and nothing else.`;
