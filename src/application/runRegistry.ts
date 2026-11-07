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
  /** Mutable: a stop flips it to `stopping`, which the next press must see. */
  state: RunState;
  /** Set once someone stops it; the Slack id of whoever did. */
  stoppedBy?: string;
  /** When the stop was asked for, so a slow death can be reported honestly. */
  stoppedAt?: number;
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
    entry.abort.abort();
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
          byId.set(run.id, { ...entry, run: { ...entry.run, state: "running" } });
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
  };
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

