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
 * Deliberately NOT applying the "your own turn, or an admin" rule that guards
 * the bot's own stop button. That rule exists because a turn is somebody's work
 * and often their money, and it is right for a button the bot drew. This button
 * is Slack's: it appears in the client to whoever can see the session, and an
 * agent that leaves it inert has broken the platform's own affordance. So a
 * press is honoured, and the notice names whose turn it was when it was not the
 * presser's - visible rather than refused.
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
