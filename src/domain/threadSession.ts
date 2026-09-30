/**
 * One CLI session per Slack thread.
 *
 * A thread is one conversation. Running every turn of it as a cold CLI
 * invocation throws away what the model just read, just ran and just worked
 * out, and pays to replay a transcript instead. A durable session keeps the
 * context and the files between turns, so a follow-up costs a follow-up.
 *
 * Two rules make it safe rather than merely cheap:
 *
 * - a session belongs to an access tier, not just a thread. Full-access and
 *   sandboxed roles run in different working directories, and the CLI files a
 *   session under the directory it ran in, so they could not share one anyway -
 *   and sharing would hand a sandboxed user whatever a full-access session had
 *   read.
 * - a session that will not resume is not an error to show anyone. The CLI
 *   prunes its own history, a database outlives the machine it was written on,
 *   and a thread must not become permanently broken because a file went away.
 */

import type { StoredMessage } from "./types.ts";

/** Which pool a turn's session comes from. Mirrors the two working directories. */
export type SessionTier = "full" | "sandbox";

export const tierOf = (policy?: { skipPermissions?: boolean }): SessionTier =>
  policy?.skipPermissions ? "full" : "sandbox";

/**
 * Did this run fail because the session it was told to resume is gone? Matched
 * on the CLI's own wording, loosely: the cost of a false positive is one cold
 * turn, the cost of a false negative is a thread that answers nothing until
 * somebody notices.
 */
export const isMissingSession = (err: unknown): boolean => {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  return (
    msg.includes("no conversation found") ||
    msg.includes("session not found") ||
    (msg.includes("session") && (msg.includes("does not exist") || msg.includes("not found")))
  );
};

/**
 * What a resumed session has not been shown yet: everything said after the turn
 * it last saw. A thread carries on while the bot is not being spoken to, so this
 * is how those messages still reach it without replaying the whole thread.
 *
 * When the marker cannot be found - stored memory with no Slack ts, a thread
 * edited underneath us - only the newest turn is sent. Handing the session a
 * little less beats handing it the conversation twice, which is what a full
 * replay into a session that already remembers it would be.
 */
export const unseenTurns = (
  history: readonly StoredMessage[],
  lastTs: string,
): StoredMessage[] => {
  if (history.length === 0) return [];
  const at = lastTs ? history.findIndex((m) => m.slackTs === lastTs) : -1;
  if (at === -1) return history.slice(-1);
  const after = history.slice(at + 1);
  return after.length > 0 ? after : history.slice(-1);
};

/**
 * Did this run get killed for taking too long? SIGTERM is how the adapter's own
 * timeout reaps a turn, so 143 means "out of time", not "broken".
 *
 * Worth telling apart: a turn that ran out of time while genuinely working -
 * reading logs, walking a repo - should say so, because "I hit an error" reads
 * as a bug and invites the same question again rather than a narrower one.
 */
export const isTimeout = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /exited with code 143\b/.test(msg);
};
