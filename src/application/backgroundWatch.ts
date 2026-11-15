/**
 * Tells a thread the moment background work its turn started has died.
 *
 * A turn can start an agent with `run_in_background` and end its answer; the
 * CLI then keeps the work alive for ten minutes and kills it. The thread used
 * to learn that only when somebody asked "???" hours later - the notice that
 * was meant to say it went into the reply's Slack stream, which had been
 * closed by then (`message_not_in_streaming_state`).
 *
 * Two ways in, one report each:
 *   - `cutOff`: the run ended (or the CLI killed the work) while this process
 *     was alive and listening;
 *   - `recover`: the process itself died with the work (restart, drain, crash),
 *     found on the next boot from the row `track` kept.
 * Both take the thread's row first, so whichever gets there reports it and the
 * other finds nothing - never twice.
 *
 * Reports with one short message in the thread, then hands the thread back to
 * a turn that can finish the work, the way a fired watch does.
 */
import { backgroundDiedNotice, backgroundHandBack, backgroundLostNotice, MAX_HANDBACKS_PER_HOUR } from "../domain/backgroundJobs.ts";
import type { BackgroundJob, BackgroundJobRepo } from "../infrastructure/db/backgroundJobRepo.ts";
import type { Clock } from "./ports.ts";
import { logAndIgnore } from "./ignoredError.ts";

export type BackgroundThread = { readonly channelId: string; readonly threadTs: string; readonly slackUserId: string };

export type BackgroundWatchDeps = {
  jobs: BackgroundJobRepo;
  clock: Clock;
  /** Say something in the thread without spending a turn. */
  say: (channelId: string, text: string, threadTs: string) => Promise<void>;
  /** Start the hand-back turn in the thread (the watcher's own `runTurn`). */
  runTurn: (req: {
    channelId: string;
    threadTs: string;
    slackUserId: string;
    text: string;
    keepSession?: boolean;
    unprompted?: boolean;
  }) => Promise<unknown>;
  /** Whether the person whose turn started the work may still have a turn run for them. */
  mayRun?: (slackUserId: string) => boolean;
  log?: (msg: string) => void;
};

export type BackgroundWatch = {
  /** The CLI's live task list for a thread's turn changed; an empty list clears it. */
  track: (thread: BackgroundThread, tasks: readonly string[]) => void;
  /** These tasks died with the run. Reported once, and only if a row says they were still unreported. */
  cutOff: (thread: BackgroundThread, tasks: readonly string[]) => Promise<boolean>;
  /**
   * Tells the threads whose work died with the PREVIOUS process: the rows that
   * were already there when this watch was created (taken then, synchronously,
   * before any turn could touch them). Returns how many threads were told.
   */
  recover: () => Promise<number>;
};

const HOUR_MS = 60 * 60_000;

export const createBackgroundWatch = (deps: BackgroundWatchDeps): BackgroundWatch => {
  const log = deps.log ?? (() => {});
  // A hand-back turn can start background work that is cut the same way; two
  // an hour per thread is a retry, more is a loop.
  const handBacks = new Map<string, number[]>();
  const keyOf = (t: { channelId: string; threadTs: string }): string => `${t.channelId}:${t.threadTs}`;
  // Whatever is in the table now is the previous process's: taken here, at boot,
  // before the inbox redelivers anything or a turn can replace or clear a row.
  // Taking them later (`recover` runs 20s on) raced both.
  const leftovers: BackgroundJob[] = [];
  try {
    for (const job of deps.jobs.list()) {
      const row = deps.jobs.claim(job.channelId, job.threadTs);
      if (row && row.tasks.length > 0) leftovers.push(row);
    }
  } catch (e) {
    log(`background boot claim failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Threads a turn of THIS process has tracked or cleared since boot. A redelivered
  // (or new) turn there already has the thread, so recovery tells it and does
  // not start a second turn on top.
  const touched = new Set<string>();

  const allowedHandBack = (key: string, now: number, user: string): boolean => {
    if (deps.mayRun && !deps.mayRun(user)) return false;
    const recent = (handBacks.get(key) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= MAX_HANDBACKS_PER_HOUR) return false;
    handBacks.set(key, [...recent, now]);
    return true;
  };

  const report = async (
    who: BackgroundThread,
    tasks: readonly string[],
    how: "cut" | "lost",
    turnRunning = false,
  ): Promise<void> => {
    const handBack = !turnRunning && allowedHandBack(keyOf(who), deps.clock(), who.slackUserId);
    const notice =
      how === "cut" ? backgroundDiedNotice(tasks, handBack) : backgroundLostNotice(tasks, handBack, turnRunning);
    await deps.say(who.channelId, notice, who.threadTs).catch(logAndIgnore("background death notice"));
    if (!handBack) return;
    try {
      void deps
        .runTurn({
          channelId: who.channelId,
          threadTs: who.threadTs,
          slackUserId: who.slackUserId,
          text: backgroundHandBack(tasks, how),
          // The session that started the work holds what it was doing.
          keepSession: true,
          unprompted: true,
        })
        .catch((e: unknown) => log(`background hand-back failed: ${e instanceof Error ? e.message : String(e)}`));
    } catch (e) {
      log(`background hand-back failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return {
    track: (thread, tasks) => {
      touched.add(keyOf(thread));
      try {
        deps.jobs.set({ ...thread, tasks }, deps.clock());
      } catch (e) {
        log(`background track failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    cutOff: async (thread) => {
      // The row, not the argument, decides whether this is still unreported.
      const row = deps.jobs.claim(thread.channelId, thread.threadTs);
      // No row: boot recovery or an earlier call already reported it, or it was
      // never tracked. Nothing to say either way.
      if (!row || row.tasks.length === 0) return false;
      await report(thread, row.tasks, "cut");
      return true;
    },
    recover: async () => {
      const jobs = leftovers.splice(0);
      let told = 0;
      for (const job of jobs) {
        await report(job, job.tasks, "lost", touched.has(keyOf(job)));
        told++;
      }
      return told;
    },
  };
};
