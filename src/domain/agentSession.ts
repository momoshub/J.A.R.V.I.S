/**
 * Slack's own stop button, on an agent session.
 *
 * A thread the bot streams into is an "agent session" as far as Slack is
 * concerned, and Slack draws the controls for it. Subscribing to
 * `agent_session_stopped` is what turns the spinner people see into an
 * interactive stop button - without the subscription Slack shows a loading
 * indicator nobody can press, which is the worst of both: it looks like a
 * control and does nothing.
 *
 * The event is Slack telling us a human pressed it. Two things are then owed,
 * and the second is the one that is easy to forget: stop the work, AND close
 * the streams Slack names, or the session sits in `processing` forever with no
 * way back. `streaming_message_ts` is how Slack says which ones were open; it
 * is empty when none were.
 *
 * The press is gated by the same rule as the bot's own stop button and the
 * `stop` command (`mayStopRun`): the turn's own actor, or someone allowed to
 * stop other people's turns (admin, owner). A turn is somebody's work and often
 * their money, and in a public channel Slack draws this button for everyone who
 * can see the session - honouring every press would let anyone kill someone
 * else's long turn. A press that is not allowed stops nothing: the run keeps
 * going, its streams stay open (the turn is still writing into them), the
 * session stays `processing`, the presser gets an ephemeral notice saying whose
 * turn it is (`sessionStopIgnoredNotice`) and the log channel gets one line
 * (`sessionStopIgnoredLog`). With nothing running in the thread there is no
 * turn to protect, so the press still closes the named streams and idles the
 * session - it must never stick in `processing`.
 *
 * What ends the session: `agents.sessions.setStatus` and nothing else. Slack
 * documents that the streaming methods (`chat.startStream`/`appendStream`/
 * `stopStream`) only deliver message content, and that "the loading UX does not
 * disappear automatically when your app posts a message. Set `status: 'active'`
 * when you finish, or the session stays in `processing` until it times out after
 * one hour." So every turn that opened a stream owes a `status: "active"` when
 * it ends, and a stop press owes one too - `stopStream` alone only closes a
 * message, and fails with `message_not_in_streaming_state` once it is closed.
 */

/** The event name to subscribe to, and to register a handler for. */
export const AGENT_SESSION_STOPPED = "agent_session_stopped";

/** The slice of the event payload we read. */
export type AgentSessionStoppedEvent = {
  readonly channel?: string;
  readonly thread_ts?: string;
  readonly user?: string;
  /** Streams Slack had open for this session; empty when there were none. */
  readonly streaming_message_ts?: readonly string[];
  readonly event_ts?: string;
};

export type SessionStopPlan =
  /** Nothing actionable - a malformed payload, or no thread to key on. */
  | { readonly kind: "ignored"; readonly why: string }
  | {
      readonly kind: "stop";
      /** Thread key, in the form the run registry and the queue use. */
      readonly key: string;
      readonly channel: string;
      readonly threadTs: string;
      readonly by: string;
      readonly streams: readonly string[];
    };

/**
 * The thread key, which must match the one `respond` builds or the stop finds
 * nothing. There it is `${channel}:${threadTs ?? messageTs}` - for a session
 * started on a top-level message those are the same ts, which is why keying on
 * Slack's `thread_ts` alone is correct here.
 */
export const sessionThreadKey = (channel: string, threadTs: string): string => `${channel}:${threadTs}`;

export const planSessionStop = (event: AgentSessionStoppedEvent): SessionStopPlan => {
  const channel = event.channel?.trim();
  const threadTs = event.thread_ts?.trim();
  const by = event.user?.trim();
  if (!channel) return { kind: "ignored", why: "no channel on the event" };
  if (!threadTs) return { kind: "ignored", why: "no thread_ts on the event" };
  if (!by) return { kind: "ignored", why: "no user on the event" };

  const streams = (event.streaming_message_ts ?? []).filter(
    (ts): ts is string => typeof ts === "string" && ts.trim().length > 0,
  );

  return { kind: "stop", key: sessionThreadKey(channel, threadTs), channel, threadTs, by, streams };
};

/**
 * The one log-channel line for a press on Slack's own stop button.
 *
 * The stopped thread is told nothing: Slack's UI already showed the presser
 * that it stopped, and a "stopped" line under every press was noise for
 * everyone else reading. The context goes to the log channel instead - who,
 * which thread, what was running and for how long. Nothing is logged when
 * nothing was running (the press still closes its stream, but there is
 * nothing to report).
 */
export const sessionStoppedLog = (
  run: { readonly what: string; readonly startedAt: number; readonly actor: string },
  press: { readonly by: string; readonly channel: string; readonly threadTs: string; readonly link?: string },
  now: number,
  forHowLong: (ms: number) => string,
): string => {
  const whose = press.by === run.actor ? "" : ` (<@${run.actor}>'s)`;
  const where = press.link ? `<${press.link}|thread>` : `<#${press.channel}> \`${press.threadTs}\``;
  return `⏹ <@${press.by}> pressed stop in ${where}: stopped *${run.what}*${whose} after ${forHowLong(now - run.startedAt)}`;
};

/** What a presser who may not stop this turn is told, privately: the press changed nothing. */
export const sessionStopIgnoredNotice = (run: { readonly actor: string }): string =>
  `I ignored that stop: it is <@${run.actor}>'s turn, and only they or an admin can stop it.`;

/** The log-channel line for a press on Slack's own stop button that was refused. */
export const sessionStopIgnoredLog = (
  run: { readonly what: string; readonly startedAt: number; readonly actor: string },
  press: { readonly by: string; readonly channel: string; readonly threadTs: string; readonly link?: string },
  now: number,
  forHowLong: (ms: number) => string,
): string => {
  const where = press.link ? `<${press.link}|thread>` : `<#${press.channel}> \`${press.threadTs}\``;
  return `⏹ <@${press.by}> pressed stop in ${where}: ignored, *${run.what}* is <@${run.actor}>'s (running ${forHowLong(now - run.startedAt)}) and keeps going`;
};

/** The method that moves an agent session between `processing` and `active`. */
export const SET_SESSION_STATUS = "agents.sessions.setStatus";

/**
 * Arguments that put a thread's agent session back to idle, which is what makes
 * Slack drop its stop button. `active` is "ready for the next prompt";
 * `processing` is the only state the button is drawn in.
 */
export const idleSessionArgs = (channel: string, threadTs: string): Record<string, unknown> => ({
  channel_id: channel,
  thread_ts: threadTs,
  status: "active",
});

/**
 * Whether the session may be idled now: no run is still live in the thread.
 * Count only runs that are not `stopping` when a stop press asks - the run it
 * just stopped stays in the registry until its turn unwinds, and counting it
 * would mean a press that stopped the only run never idles. A run that ENDS
 * is asked of the registry instead (`onSessionIdle`), which idles for whichever
 * run goes last, whether or not that run ever opened a stream.
 */
export const mayIdleSession = (stillLive: number): boolean => stillLive === 0;
