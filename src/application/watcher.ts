/**
 * The thing that actually waits.
 *
 * It runs outside every turn and every session: a timer in the bot process
 * that asks each due watch "are you ready yet" by running its shell predicate,
 * and when one finally says yes, hands the thread a fresh turn that carries on
 * from where the last one stopped.
 *
 * Polling here costs nothing - no model, no session, no queue slot - which is
 * the whole reason the waiting does not happen inside the turn. A turn asleep
 * for twenty minutes burns its own timeout AND blocks the thread it is in,
 * because the queue runs one at a time.
 *
 * Every exit tells the thread something. A watch that quietly stopped would
 * reproduce the exact failure it was built to fix, so there are only three
 * ends: it fired, it ran out of time, or its check kept erroring - and all
 * three post.
 */
import {
  gaveUpMessage,
  MAX_CONSECUTIVE_ERRORS,
  readyMessage,
  type WatchState,
} from "../domain/watch.ts";
import type { Watch, WatchRepo } from "../infrastructure/db/watchRepo.ts";
import type { Clock } from "./ports.ts";

/** Result of running a watch's predicate. */
export type CheckResult = {
  /** Exit code; 0 means ready. */
  readonly code: number;
  readonly output: string;
  /** Set when the command could not be run at all. */
  readonly error?: string;
};

export type WatcherDeps = {
  watches: WatchRepo;
  clock: Clock;
  /** Run a predicate. Bounded by the adapter, never here. */
  check: (cmd: string, timeoutMs: number) => Promise<CheckResult>;
  /** Start the follow-up turn in the watched thread. */
  runTurn: (req: {
    channelId: string;
    threadTs: string;
    slackUserId: string;
    text: string;
    /** Resume the thread's session even if its rules changed since. */
    keepSession?: boolean;
    /** Nobody typed it, so it queues without a busy notice. */
    unprompted?: boolean;
  }) => Promise<void>;
  /** Say something in the thread without spending a turn. */
  say?: (channelId: string, text: string, threadTs: string) => Promise<void>;
  /**
   * Whether whoever set the watch may still have it run. A predicate is a
   * shell command run as the bot, so a person whose role was switched off (or
   * who was removed) must not keep one ticking. Absent means always.
   */
  mayRun?: (slackUserId: string) => boolean;
  log?: (msg: string) => void;
  /**
   * What a check printed when its watch fired, for whoever keeps something from
   * it (`watch worker` prints the worker's usage). Called before the hand-back
   * starts; a throw here is logged and never stops the hand-back.
   */
  onFired?: (watch: Watch, output: string) => void;
  /**
   * A tick that cannot even read what is due. Handed over, never thrown: the
   * tick runs on a bare timer, and a rejection there kills the whole process.
   */
  onError?: (e: unknown) => void;
};

/** How long one predicate may run before it is treated as an error. */
export const CHECK_TIMEOUT_MS = 30_000;

export type Watcher = {
  /** Check everything that is due. Safe to call on a timer. */
  tick: () => Promise<void>;
};

export const createWatcher = (deps: WatcherDeps): Watcher => {
  const log = deps.log ?? (() => {});
  // A tick that overruns its interval must not have a second one land on top
  // of it: two ticks would run the same due watch twice and fire it twice.
  let running = false;

  // The row is settled before the turn starts, so the turn itself is never
  // awaited: a hand-back can run for half an hour, and a tick held on it left
  // every other due watch unchecked for just as long (#190 held #191 that way).
  const finish = (w: Watch, state: WatchState, text: string, error?: string): void => {
    deps.watches.settle(w.id, state, deps.clock(), error);
    // The turn is the point of the watch, so losing it is worth a word in
    // the thread rather than only a line in the log.
    const lost = (e: unknown): Promise<void> => {
      const msg = e instanceof Error ? e.message : String(e);
      log(`watch ${w.id} could not start its turn: ${msg}`);
      return (
        deps.say?.(w.channelId, `I finished waiting but could not pick the thread back up: ${msg}`, w.threadTs) ??
        Promise.resolve()
      ).catch(() => {});
    };
    try {
      void deps
        .runTurn({
          channelId: w.channelId,
          threadTs: w.threadTs,
          slackUserId: w.slackUserId,
          text,
          // The session that set the watch holds the job; a restart in between
          // (shipping a feature, say) must not hand it to a cold turn.
          keepSession: true,
          // The bot's own note to itself: queued behind a running turn, it must
          // not tell the person "yours is next" about a message they never sent.
          unprompted: true,
        })
        .catch(lost);
    } catch (e) {
      void lost(e);
    }
  };

  const one = async (w: Watch): Promise<void> => {
    const now = deps.clock();
    const waited = now - w.createdAt;

    // Checked before the predicate runs, never after: the predicate is the
    // authority. Settled quietly with one line - no hand-back turn, which the
    // same person could not run anyway.
    if (deps.mayRun && !deps.mayRun(w.slackUserId)) {
      deps.watches.settle(w.id, "failed", now, "setter no longer allowed");
      log(`watch ${w.id} stopped: ${w.slackUserId} is no longer allowed to run it`);
      await (
        deps.say?.(w.channelId, `Stopped waiting: whoever set this watch is no longer allowed to run it.`, w.threadTs) ??
        Promise.resolve()
      ).catch(() => {});
      return;
    }

    // A watch with no predicate is a plain timer: the deadline IS the event.
    if (!w.check.trim()) {
      if (now >= w.deadlineAt) finish(w, "fired", readyMessage(w.note, waited));
      else deps.watches.reschedule(w.id, Math.min(now + w.everyMs, w.deadlineAt), now);
      return;
    }

    const res = await deps.check(w.check, CHECK_TIMEOUT_MS);

    if (res.error) {
      const errors = w.errors + 1;
      deps.watches.reschedule(w.id, now + w.everyMs, now, res.error);
      if (errors >= MAX_CONSECUTIVE_ERRORS) {
        finish(
          w,
          "failed",
          gaveUpMessage(w.note, waited, `the check kept failing to run (${res.error})`),
          res.error,
        );
      }
      return;
    }

    if (res.code === 0) {
      try {
        deps.onFired?.(w, res.output);
      } catch (e) {
        log(`watch ${w.id}: keeping what it printed failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      finish(w, "fired", readyMessage(w.note, waited, res.output));
      return;
    }

    if (now >= w.deadlineAt) {
      finish(w, "expired", gaveUpMessage(w.note, waited, "it never became ready"));
      return;
    }
    // Not ready, not out of time: ask again later. A non-zero exit is the
    // normal answer here, so it clears the error streak rather than feeding it.
    deps.watches.reschedule(w.id, now + w.everyMs, now);
  };

  return {
    tick: async () => {
      if (running) return;
      running = true;
      try {
        let due: Watch[];
        try {
          due = deps.watches.due(deps.clock());
        } catch (e) {
          log(`could not read due watches: ${e instanceof Error ? e.message : String(e)}`);
          deps.onError?.(e);
          return;
        }
        for (const w of due) {
          try {
            await one(w);
          } catch (e) {
            // One bad watch must never stop the others being checked.
            log(`watch ${w.id} failed: ${e instanceof Error ? e.message : String(e)}`);
            deps.watches.reschedule(w.id, deps.clock() + w.everyMs, deps.clock(), "tick failed");
          }
        }
      } finally {
        running = false;
      }
    },
  };
};
