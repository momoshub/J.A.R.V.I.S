/**
 * The thing that fires loops.
 *
 * Everything a loop says lands in its creator's DM, never in the channel or
 * thread it was created in: a scheduled turn with nobody present should not
 * speak in a shared room. Each fire opens a fresh top-level DM message and the
 * turn runs under it, so runs do not pile into one thread.
 *
 * Same shape as the watcher and for the same reason - it runs outside every
 * turn, polling a table, and costs nothing until something is due. When a loop
 * is due it hands its thread a turn through the SAME `runTurn` the watcher
 * uses; there is no second way to wake a thread.
 *
 * A loop is always moved on from NOW, before its turn starts. That one rule is
 * the whole catch-up policy: a bot that was down over three slots runs the loop
 * once on startup and carries on from there, never a burst.
 */
import { loopRef, loopTurnText, nextRun, parseSchedule } from "../domain/loop.ts";
import type { Loop, LoopRepo } from "../infrastructure/db/loopRepo.ts";
import type { Clock } from "./ports.ts";
import { logAndIgnore } from "./ignoredError.ts";
import { CHECK_TIMEOUT_MS, type CheckResult } from "./watcher.ts";

/** Same hand-back as the watcher's, so both wake a thread the same way. */
export type LoopTurnRequest = {
  channelId: string;
  threadTs: string;
  slackUserId: string;
  text: string;
  keepSession?: boolean;
  unprompted?: boolean;
};

export type LoopRunnerDeps = {
  loops: LoopRepo;
  clock: Clock;
  runTurn: (req: LoopTurnRequest) => Promise<void>;
  /** Minutes east of UTC that schedules are read in. */
  offsetMinutes: () => number;
  /**
   * Post a new top-level message in the user's DM with the bot (opening the DM
   * when needed) and say where it landed, resolved at fire time from the
   * creator's id. Nothing posts without it.
   */
  dm: (slackUserId: string, text: string) => Promise<{ channel: string; ts: string } | undefined>;
  /** The watcher's shell runner: same cwd, env and timeout. Without it a script loop is stopped. */
  check?: (cmd: string, timeoutMs: number) => Promise<CheckResult>;
  /**
   * Whether the creator may still run this kind of loop unattended; false stops
   * it. A script loop is shell, so it asks for more than a prompt loop does.
   */
  mayRun?: (slackUserId: string, script: boolean) => boolean;
  /** Runs first on every tick: deletes pending script loops nobody approved in time. */
  sweep?: () => Promise<unknown>;
  log?: (msg: string) => void;
  onError?: (e: unknown) => void;
};

export type LoopRunner = {
  /** Fire everything that is due. Safe to call on a timer. */
  tick: () => Promise<void>;
};

export const createLoopRunner = (deps: LoopRunnerDeps): LoopRunner => {
  const log = deps.log ?? (() => {});
  // An overrunning tick must not let a second one fire the same loop twice.
  let running = false;

  const say = (l: Loop, text: string, what: string): Promise<void> =>
    deps.dm(l.createdBy, text).then(() => undefined, logAndIgnore(what));

  const runScript = async (l: Loop, next: number): Promise<void> => {
    const fail = (why: string): Promise<void> => {
      log(`loop ${l.id} script failed: ${why}`);
      deps.loops.reschedule(l.id, next, deps.clock(), why);
      return say(l, `${loopRef(l.id, l.name)}: script failed: ${why}`, "loop script failure notice");
    };
    if (!deps.check) return fail("no shell runner wired");
    try {
      const res = await deps.check(l.command, CHECK_TIMEOUT_MS);
      if (res.error) return await fail(res.error);
      if (res.code !== 0) {
        const last = res.output.trim().split("\n").pop()?.slice(0, 120) ?? "";
        return await fail(`exit ${res.code}${last ? ` - ${last}` : ""}`);
      }
    } catch (e) {
      await fail(e instanceof Error ? e.message : String(e));
    }
  };

  const one = async (l: Loop): Promise<void> => {
    const now = deps.clock();
    // Never run what is not active, whatever the query handed over: a pending script loop is unapproved shell.
    if (l.state !== "active") return;

    if (deps.mayRun && !deps.mayRun(l.createdBy, !!l.command)) {
      deps.loops.settle(l.id, "failed", now, "creator no longer allowed");
      log(`loop ${l.id} stopped: ${l.createdBy} is no longer allowed to run it`);
      await say(l, `Stopped ${loopRef(l.id, l.name)}: whoever set it is no longer allowed to run it.`, "loop stopped notice");
      return;
    }

    const schedule = parseSchedule(l.schedule);
    if (!schedule) {
      deps.loops.settle(l.id, "failed", now, "unreadable schedule");
      log(`loop ${l.id} stopped: cannot read schedule "${l.schedule}"`);
      return;
    }

    // Moved on first, so a slow or failing turn can never re-fire this slot.
    const next = nextRun(schedule, now, deps.offsetMinutes());
    deps.loops.fired(l.id, next, now);

    if (l.command) {
      // No turn, no tokens: the command runs as a watch's check does, and only a
      // failure says anything. Not awaited, like a turn, so a slow script does
      // not hold the other due loops.
      void runScript(l, next);
      return;
    }

    // One fresh top-level DM message per fire; the turn runs in its thread.
    let ref: { channel: string; ts: string } | undefined;
    try {
      ref = await deps.dm(l.createdBy, `🔁 ${l.name} - loop #${l.id}, ${l.schedule}`);
    } catch (e) {
      ref = undefined;
      log(`loop ${l.id}: could not open the DM: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!ref) {
      deps.loops.reschedule(l.id, next, deps.clock(), "could not open the creator's DM");
      return;
    }
    const lost = (e: unknown): void => {
      const msg = e instanceof Error ? e.message : String(e);
      log(`loop ${l.id} could not start its turn: ${msg}`);
      deps.loops.reschedule(l.id, next, deps.clock(), msg);
      void say(l, `${loopRef(l.id, l.name)}: could not start its turn: ${msg}`, "loop start-failed notice");
    };
    try {
      // Not awaited: a turn can run for half an hour and must not hold the
      // other due loops.
      void deps
        .runTurn({
          channelId: ref.channel,
          threadTs: ref.ts,
          slackUserId: l.createdBy,
          text: loopTurnText(l.id, l.schedule, l.prompt, l.name),
          // The bot's own scheduled note, not a message anyone sent.
          unprompted: true,
        })
        .catch(lost);
    } catch (e) {
      lost(e);
    }
  };

  return {
    tick: async () => {
      if (running) return;
      running = true;
      try {
        await deps.sweep?.().catch(logAndIgnore("loop pending sweep"));
        let due: Loop[];
        try {
          due = deps.loops.due(deps.clock());
        } catch (e) {
          log(`could not read due loops: ${e instanceof Error ? e.message : String(e)}`);
          deps.onError?.(e);
          return;
        }
        for (const l of due) {
          try {
            await one(l);
          } catch (e) {
            // One bad loop must never stop the others being fired.
            log(`loop ${l.id} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } finally {
        running = false;
      }
    },
  };
};
