/**
 * The turns currently in flight, so one can be stopped.
 *
 * A turn can run for the better part of an hour, and until now the only way to
 * deal with one going the wrong way was to wait it out: a follow-up message
 * queued behind it, which is the opposite of what someone correcting course
 * wants. This holds a handle on each running turn so a button or a command can
 * end it.
 *
 * Stopping is cooperative at the edges and forceful at the centre: the signal
 * is passed to the CLI adapter, which kills the child process, and the turn's
 * own code checks `aborted` so a queued turn that was dropped before it started
 * never spawns anything at all.
 */

/**
 * `stopping` is its own state because a stop is a REQUEST, not an event. The
 * process may take a moment to die, or - as happened - never die at all, and a
 * registry that cannot tell "asked to stop" from "running" reports a fresh
 * successful stop every time the button is pressed. Pressing it four times on a
 * wedged turn got four confirmations and killed nothing.
 */
export type RunState = "running" | "queued" | "stopping";

export type TrackedRun = {
  /** Short id, carried on the buttons. */
  readonly id: string;
  /** Thread key this run belongs to, matching the queue's. */
  readonly key: string;
  readonly channelId: string;
  readonly threadTs?: string;
  /** Who asked for it, so the thread can say whose turn was stopped. */
  readonly actor: string;
  /** The first words of the request, to name it in a notice. */
  readonly what: string;
  /** The message that asked for it, so a notice can link to it. */
  readonly messageTs?: string;
  readonly startedAt: number;
  /**
   * A long job nobody is sitting watching - a workflow worker carrying on by
   * itself. It is still a run, and still stoppable, but it must not be able to
   * hold a restart open: it gets cut and redelivered on the same session, so
   * waiting for it only buys deafness.
   */
  readonly background?: boolean;
  /**
   * The gateway inbox row that started it, if any. A turn started while a
   * restart waits runs on a budget, and past it the row is cut: this is how
   * the row finds the turn to stop.
   */
  readonly inboxRowId?: number;
  /** Mutable: a stop flips it to `stopping`, which the next press must see. */
  state: RunState;
  /** Set once someone stops it; the Slack id of whoever did. */
  stoppedBy?: string;
  /** When the stop was asked for, so a slow death can be reported honestly. */
  stoppedAt?: number;
  /**
   * The streamed messages this turn opened. Slack's stop button names every
   * open stream in the session, including the one a queued message already
   * opened for its thinking card - this is how the press tells them apart.
   */
  streams?: string[];
};

export type RunRegistry = {
  /**
   * Track a turn. Returns the signal to hand down to the CLI and a `done` to
   * call when the turn ends, however it ends.
   */
  track: (run: Omit<TrackedRun, "state" | "stoppedBy">) => {
    signal: AbortSignal;
    running: () => void;
    done: () => void;
  };
  /** What is running (or queued) in this thread right now. */
  inThread: (key: string) => TrackedRun[];
  /** The running turn of a thread, if there is one. */
  current: (key: string) => TrackedRun | undefined;
  byId: (id: string) => TrackedRun | undefined;
  /**
   * Stop a run by id. Returns what was stopped, or undefined when it had
   * already finished - which is common, because a button sits in Slack for as
   * long as anyone cares to leave it there.
   */
  stop: (id: string, by: string) => TrackedRun | undefined;
  /** Stop whatever is running in a thread. Returns what was stopped. */
  stopThread: (key: string, by: string) => TrackedRun | undefined;
  /** Every tracked run, whatever thread it is in - for a status report. */
  all: () => TrackedRun[];
  /**
   * Record that the turn answering this message opened a streamed message.
   * Matched by the message, because the stream is made before the turn has a
   * run id anyone outside it can see.
   */
  streamOpened: (channelId: string, messageTs: string, streamTs: string) => void;
};

type Entry = { run: TrackedRun; abort: AbortController };

export const createRunRegistry = (clock: () => number = () => Date.now()): RunRegistry => {
  const byId = new Map<string, Entry>();

  // Undefined when it has ALREADY been asked to stop: the caller needs to tell
  // "I stopped it" from "it was asked and has not let go", and only the first
  // of those should be reported as an action.
  const stopEntry = (entry: Entry, by: string): TrackedRun | undefined => {
    if (entry.run.state === "stopping") return undefined;
    entry.run.stoppedBy = by;
    entry.run.stoppedAt = clock();
    entry.run.state = "stopping";
    // The reason is who stopped it, so a restart's cut can be told apart
    // from a person pressing stop (`isRestartCut`).
    entry.abort.abort(by);
    return entry.run;
  };

  return {
    all: () => [...byId.values()].map((e) => e.run),
    track: (run) => {
      const abort = new AbortController();
      const entry: Entry = { run: { ...run, state: "queued" }, abort };
      byId.set(run.id, entry);
      return {
        signal: abort.signal,
        // Called when the turn actually starts, as opposed to waiting its turn
        // in the queue - the two are stopped with different words.
        running: () => {
          // In place: a copy would drop what was recorded on the old object.
          entry.run.state = "running";
        },
        done: () => {
          byId.delete(run.id);
        },
      };
    },
    inThread: (key) => [...byId.values()].filter((e) => e.run.key === key).map((e) => e.run),
      current: (key) => [...byId.values()].find((e) => e.run.key === key && e.run.state === "running")?.run,
    byId: (id) => byId.get(id)?.run,
    stop: (id, by) => {
      const entry = byId.get(id);
      return entry ? stopEntry(entry, by) : undefined;
    },
    stopThread: (key, by) => {
      const entry = [...byId.values()].find((e) => e.run.key === key && e.run.state === "running");
      return entry ? stopEntry(entry, by) : undefined;
    },
    streamOpened: (channelId, messageTs, streamTs) => {
      const entry = [...byId.values()].find((e) => e.run.channelId === channelId && e.run.messageTs === messageTs);
      if (!entry) return;
      entry.run.streams = [...(entry.run.streams ?? []), streamTs];
    },
  };
};

/**
 * Which of the streams Slack's stop button named should be closed: all of
 * them, except one still owned by a turn that is not being stopped. Closing
 * those used to kill a queued message's reply along with the turn the press
 * was meant for. A stream nobody owns any more is closed, so a session left
 * in `processing` by a finished turn can still leave it.
 */
export const streamsToClose = (runs: RunRegistry, streams: readonly string[]): string[] => {
  const kept = new Set(
    runs
      .all()
      .filter((r) => r.state !== "stopping")
      .flatMap((r) => r.streams ?? []),
  );
  return streams.filter((ts) => !kept.has(ts));
};

export type RunPressOutcome =
  /** The running turn was ended. */
  | { kind: "stopped"; run: TrackedRun }
  /** A turn that had not started yet was taken back off the queue. */
  | { kind: "dropped"; run: TrackedRun }
  /** The button outlived what it pointed at - it finished on its own. */
  | { kind: "gone" }
  /** Already asked to stop and still letting go; pressing again changes nothing. */
  | { kind: "stopping"; run: TrackedRun }
  /** Not theirs to stop. */
  | { kind: "refused" }
  | { kind: "ignored" };

/** Who a restart's cut is recorded as, in place of a Slack id. */
export const RESTART_STOPPER = "restart";

/**
 * Cut the turns an inbox row started, because it ran past its budget while a
 * restart waits. Returns what was cut, one per run; empty when nothing of it
 * is still running (it finished, or it was never a tracked turn), in which
 * case the row is left alone.
 */
export const cutForRestart = (runs: RunRegistry, rowId: number): TrackedRun[] =>
  runs
    .all()
    .filter((r) => r.inboxRowId === rowId)
    .map((r) => runs.stop(r.id, RESTART_STOPPER))
    .filter((r): r is TrackedRun => r !== undefined);

/** Whether this turn was stopped by a restart's budget rather than by a person. */
export const isRestartCut = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true && signal.reason === RESTART_STOPPER;

/**
 * Where to tell the cut turns to hold on: once per thread, and in the thread
 * even for a top-level message, whose reply opens one under it.
 */
export const holdThreads = (cut: readonly TrackedRun[]): { channelId: string; threadTs?: string }[] => {
  const seen = new Map<string, { channelId: string; threadTs?: string }>();
  for (const r of cut) {
    const threadTs = r.threadTs ?? r.messageTs;
    const key = `${r.channelId}/${threadTs ?? ""}`;
    if (!seen.has(key)) seen.set(key, threadTs ? { channelId: r.channelId, threadTs } : { channelId: r.channelId });
  }
  return [...seen.values()];
};

/**
 * What the receiver calls when a row runs past its restart budget: cut the
 * turns it started and tell each thread to hold on - once per thread for the
 * whole drain, since two messages in one thread both run over within a tick
 * of each other. True when something was cut.
 */
export const createRestartCutter = (
  runs: RunRegistry,
  post: (channelId: string, text: string, threadTs?: string) => void,
  notice: string,
): ((rowId: number) => boolean) => {
  const told = new Set<string>();
  return (rowId) => {
    const cut = cutForRestart(runs, rowId);
    for (const t of holdThreads(cut)) {
      const key = `${t.channelId}/${t.threadTs ?? ""}`;
      if (told.has(key)) continue;
      told.add(key);
      post(t.channelId, notice, t.threadTs);
    }
    return cut.length > 0;
  };
};

/**
 * Whether the work from before a restart was asked for is done: no inbox row
 * claimed before it is still in flight, and no foreground turn that started
 * before it is running or queued. Background (workflow) turns never count.
 */
export const drainSettled = (runs: RunRegistry, unbudgetedInFlight: number, drainStartedAt: number): boolean =>
  unbudgetedInFlight === 0 && !runs.all().some((r) => !r.background && r.startedAt < drainStartedAt);
