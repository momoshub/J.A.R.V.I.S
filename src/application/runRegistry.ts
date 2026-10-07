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

/** Button on the "I am still busy" notice: end the running turn. */
export const STOP_ACTION = "run_stop";
/** Button on the same notice: drop the message that was just queued. */
export const DROP_ACTION = "run_drop";

export type RunState = "running" | "queued";

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
  readonly startedAt: number;
  readonly state: RunState;
  /** Set once someone stops it; the Slack id of whoever did. */
  stoppedBy?: string;
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
};

type Entry = { run: TrackedRun; abort: AbortController };

export const createRunRegistry = (): RunRegistry => {
  const byId = new Map<string, Entry>();

  const stopEntry = (entry: Entry, by: string): TrackedRun => {
    entry.run.stoppedBy = by;
    entry.abort.abort();
    return entry.run;
  };

  return {
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
  /** Not theirs to stop. */
  | { kind: "refused" }
  | { kind: "ignored" };

/**
 * What a press of one of these buttons means.
 *
 * Kept out of the transport so the rule - your own turn, or an admin's say - is
 * stated once and can be tested without a Slack in the way. A button that
 * outlived its run is not an error: it sat in the channel while the work
 * finished on its own, which is the happy ending.
 */
export const decideRunPress = (
  runs: RunRegistry,
  press: { actionId: string; value: string; by: string; isAdmin: boolean },
): RunPressOutcome => {
  if (press.actionId !== STOP_ACTION && press.actionId !== DROP_ACTION) return { kind: "ignored" };
  const run = runs.byId(press.value);
  if (!run) return { kind: "gone" };
  // Anyone may stop what they asked for; stopping someone else's takes an admin,
  // because a turn is somebody's work and often their money.
  if (run.actor !== press.by && !press.isAdmin) return { kind: "refused" };
  const wasRunning = run.state === "running";
  const stopped = runs.stop(press.value, press.by);
  if (!stopped) return { kind: "gone" };
  return wasRunning ? { kind: "stopped", run: stopped } : { kind: "dropped", run: stopped };
};
