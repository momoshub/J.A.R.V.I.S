/**
 * Is the bot actually listening?
 *
 * Socket Mode fails in a way that looks like health from every angle: the
 * process stays up, the supervisor reports it running, the dashboard answers on
 * loopback, and the logs go quiet - which is indistinguishable from a quiet
 * afternoon. Twice now that has been a multi-hour outage nobody could see,
 * because `KeepAlive` only revives a process that has actually exited.
 *
 * So the rule is: a socket that is not connected, and has not come back within
 * the grace period, is a dead process that has not noticed yet. Exiting is the
 * repair - the supervisor starts a fresh one with a fresh connection, which is
 * the same thing a human would do, minus the hours.
 *
 * Reconnecting counts as not connected. The 22-hour outage was spent entirely
 * in reconnect attempts that would never succeed; a client that is trying is
 * not a client that is hearing anyone.
 */

/** What the socket is doing, as far as we have been told. */
export type ConnectionState = "connected" | "connecting" | "reconnecting" | "disconnected" | "unknown";

/** How long a socket may be away before the process gives up on itself. */
export const CONNECTION_GRACE_MS = 180_000;

export type ConnectionHealth = {
  state: ConnectionState;
  /** When it entered that state. */
  since: number;
};

export const isListening = (state: ConnectionState): boolean => state === "connected";

/**
 * Should the process exit and let the supervisor restart it?
 *
 * Never while connected, and never before the grace period: a blip that heals
 * itself in seconds is normal, and restarting through one would drop work for
 * no reason.
 */
export const shouldGiveUp = (
  health: ConnectionHealth,
  now: number,
  graceMs: number = CONNECTION_GRACE_MS,
): boolean => !isListening(health.state) && now - health.since >= graceMs;

/** Plain words for a log line or the dashboard, so "deaf" is never a silence. */
export const describeConnection = (health: ConnectionHealth, now: number): string => {
  const secs = Math.max(0, Math.round((now - health.since) / 1000));
  const forHowLong = secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`;
  return isListening(health.state)
    ? `listening, connected for ${forHowLong}`
    : `NOT listening - ${health.state} for ${forHowLong}`;
};
