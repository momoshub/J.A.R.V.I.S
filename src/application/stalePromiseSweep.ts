/**
 * The stale-promise sweep: every `STALE_PROMISE_INTERVAL_MS`, outside any turn,
 * it finds threads the bot was active in recently whose newest message is the
 * bot's own, old enough, promises further work, and has nothing waiting on it
 * (no turn, watch, reminder or live worker), and steers each one's session
 * once through the same internal `tell` turn: do the work now, set a watch, or
 * end with NO_REPLY. The sweep posts nothing to Slack itself.
 *
 * Cheap checks run first (the thread's own state, then Slack, then the
 * promise heuristic, then the worker probe, then the model), so a quiet
 * workspace costs one query. Each bot message is nudged at most once: its ts is
 * stored before the turn starts, so a restart never repeats it. A failed
 * lookup leaves the thread for the next sweep.
 */
import {
  eligible,
  looksLikePromise,
  nudgeText,
  parseNudged,
  pruneNudged,
  threadKey,
  tsMs,
  type NudgedMap,
} from "../domain/stalePromise.ts";
import { steerPrompt } from "../domain/tellPrompt.ts";
import type { EndedThread } from "../infrastructure/db/messageRepo.ts";
import { logAndIgnore } from "./ignoredError.ts";
import type { Clock } from "./ports.ts";

export type StalePromiseDeps = {
  readonly clock: Clock;
  /** Off switch, read every tick. */
  readonly enabled: () => boolean;
  /** Threads whose newest stored turn is the bot's, written in [since, before]. */
  readonly threads: (since: number, before: number, limit: number) => readonly EndedThread[];
  /** The thread as Slack has it, oldest first. */
  readonly replies: (channelId: string, threadTs: string) => Promise<readonly { ts: string; own: boolean; text: string }[]>;
  readonly turnRunning: (channelId: string, threadTs: string) => boolean;
  readonly workflowActive: (channelId: string, threadTs: string) => boolean;
  readonly watches: (channelId: string, threadTs: string) => number;
  readonly reminders: (channelId: string, threadTs: string) => number;
  /** A worker or background session the thread started is still running (or could not be checked). */
  readonly liveWorker: (channelId: string, threadTs: string) => Promise<boolean>;
  /** Model confirmation of a heuristic match; absent = the heuristic alone decides. Throws on failure. */
  readonly confirm?: (text: string, who: EndedThread) => Promise<boolean>;
  /** Whether that person may still run turns. */
  readonly mayRun: (slackUserId: string) => boolean;
  /** The `tell` turn: the same internal function `tell` calls. */
  readonly runTurn: (req: {
    channelId: string;
    threadTs: string;
    slackUserId: string;
    text: string;
    keepSession?: boolean;
    unprompted?: boolean;
  }) => Promise<unknown>;
  readonly settings: { get: (key: string) => string | undefined; set: (key: string, value: string) => void };
  readonly nudgedKey: string;
  readonly minAgeMs: number;
  readonly windowMs: number;
  readonly maxNudges: number;
  /** Most threads read from Slack in one sweep. */
  readonly maxLooks?: number;
  readonly log?: (msg: string) => void;
  /** The activity log. */
  readonly activity?: (event: string, data: Record<string, unknown>) => void;
};

export type StalePromiseSweep = {
  /** One sweep; resolves with how many threads were nudged. Never throws, never overlaps itself. */
  tick: () => Promise<number>;
};

const MAX_LOOKS = 40;

export const createStalePromiseSweep = (deps: StalePromiseDeps): StalePromiseSweep => {
  let running = false;
  const log = deps.log ?? (() => {});

  const once = async (): Promise<number> => {
    if (!deps.enabled()) return 0;
    const now = deps.clock();
    let nudged: NudgedMap = pruneNudged(parseNudged(deps.settings.get(deps.nudgedKey)), now);
    const candidates = deps.threads(now - deps.windowMs, now - deps.minAgeMs, 200);
    let looks = 0;
    let sent = 0;
    for (const t of candidates) {
      if (sent >= deps.maxNudges || looks >= (deps.maxLooks ?? MAX_LOOKS)) break;
      const key = threadKey(t.channelId, t.threadTs);
      const state = {
        turnRunning: deps.turnRunning(t.channelId, t.threadTs),
        workflowActive: deps.workflowActive(t.channelId, t.threadTs),
        watches: deps.watches(t.channelId, t.threadTs),
        reminders: deps.reminders(t.channelId, t.threadTs),
        liveWorker: false,
      };
      // The stored turn already says the bot spoke last; Slack says whether it still does.
      const early = eligible({ ...state, lastIsOwn: true, lastTs: String(t.lastAt / 1000), now, minAgeMs: 0 });
      if (!early.ok) continue;
      looks++;
      let last: { ts: string; own: boolean; text: string } | undefined;
      try {
        last = (await deps.replies(t.channelId, t.threadTs)).at(-1);
      } catch (e) {
        log(`could not read ${key}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (!last) continue;
      const verdict = eligible({
        ...state,
        lastIsOwn: last.own,
        lastTs: last.ts,
        now,
        minAgeMs: deps.minAgeMs,
        ...(nudged[key] ? { nudgedTs: nudged[key].ts } : {}),
      });
      if (!verdict.ok || !looksLikePromise(last.text)) continue;
      if (await deps.liveWorker(t.channelId, t.threadTs).catch(() => true)) continue;
      if (!deps.mayRun(t.slackUserId)) continue;
      if (deps.confirm) {
        const promised = await deps.confirm(last.text, t).catch((e: unknown) => {
          log(`classification failed for ${key}: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        });
        if (!promised) continue;
      }
      // Recorded before the turn starts: a restart mid-turn must not nudge again.
      nudged = { ...nudged, [key]: { ts: last.ts, at: now } };
      deps.settings.set(deps.nudgedKey, JSON.stringify(nudged));
      const ageMs = now - tsMs(last.ts);
      const minutes = Math.round(ageMs / 60_000);
      log(`nudged ${key} (bot message ${last.ts}, ${minutes} min old)`);
      deps.activity?.("stale_promise_nudge", { channel: t.channelId, thread: t.threadTs, messageTs: last.ts, ageMinutes: minutes });
      sent++;
      // Not awaited: the turn waits its place in that thread's queue.
      void deps
        .runTurn({
          channelId: t.channelId,
          threadTs: t.threadTs,
          slackUserId: t.slackUserId,
          text: steerPrompt("The stale-promise sweep (a timer in the bot, not a person) sent this", nudgeText(ageMs)),
          keepSession: true,
          unprompted: true,
        })
        .catch(logAndIgnore("stale promise nudge turn"));
    }
    return sent;
  };

  return {
    tick: async () => {
      if (running) return 0;
      running = true;
      try {
        return await once();
      } catch (e) {
        log(`sweep failed: ${e instanceof Error ? e.message : String(e)}`);
        return 0;
      } finally {
        running = false;
      }
    },
  };
};
