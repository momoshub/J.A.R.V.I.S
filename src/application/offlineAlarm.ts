/**
 * The dead man's switch that reports the host offline (see domain/offlineAlarm.ts).
 *
 * Each tick, in this order:
 *   1. arm a fresh notice `OFFLINE_ALARM_LEAD_MS` out
 *   2. cancel every other armed notice, including ones a previous process left
 *   3. close any offline notice Slack posted while we were gone
 * Arming before cancelling means there is never a moment with nothing armed,
 * and arming before closing means a notice that will not edit cannot stop the
 * next one from being armed.
 * A tick that fails - which is the whole point while offline - just logs: the
 * notice already armed is what speaks for us.
 */
import {
  isArmedNotice,
  OFFLINE_ALARM_LEAD_MS,
  offlineNotice,
  onlineNotice,
  openOfflineBeat,
  type AlarmMessage,
} from "../domain/offlineAlarm.ts";
import type { Clock } from "./ports.ts";

export type ScheduledMessage = { readonly id: string; readonly text?: string };
export type ChannelMessage = { readonly ts: string; readonly blocks?: readonly unknown[] };

/** The few Slack calls the switch needs, all on the bot token. */
export type OfflineAlarmSlack = {
  schedule: (channel: string, postAtSecs: number, msg: AlarmMessage) => Promise<string>;
  scheduled: (channel: string) => Promise<readonly ScheduledMessage[]>;
  unschedule: (channel: string, id: string) => Promise<void>;
  /** The bot's own recent messages in the channel, newest first. */
  recent: (channel: string) => Promise<readonly ChannelMessage[]>;
  update: (channel: string, ts: string, msg: AlarmMessage) => Promise<void>;
};

export type OfflineAlarmDeps = {
  readonly channel: string;
  readonly slack: OfflineAlarmSlack;
  readonly clock: Clock;
  readonly leadMs?: number;
  /** The most a stop waits on `disarm`, so a stalled network cannot hold shutdown. */
  readonly disarmWaitMs?: number;
  readonly log?: (msg: string) => void;
};

export type OfflineAlarm = {
  /** Arm, cancel the rest, close. Never throws, safe on a timer. */
  tick: () => Promise<void>;
  /**
   * Stop ticking and cancel every armed notice: for a deliberate stop (SIGTERM,
   * SIGINT), which is not an outage. Waits for a tick in flight first, or the
   * notice it is arming would outlive the stop. Bounded by `disarmWaitMs`.
   */
  disarm: () => Promise<void>;
};

/** Default bound on `disarm`, under launchd's 20s stop timeout with room for the rest of shutdown. */
export const DISARM_WAIT_MS = 5_000;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const createOfflineAlarm = (deps: OfflineAlarmDeps): OfflineAlarm => {
  const log = deps.log ?? (() => {});
  const leadMs = deps.leadMs ?? OFFLINE_ALARM_LEAD_MS;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  // Logged once per outage, not once a minute.
  let failing = false;

  const closeOpenNotices = async (): Promise<void> => {
    for (const m of await deps.slack.recent(deps.channel)) {
      const beat = openOfflineBeat(m.blocks);
      if (beat === undefined) continue;
      await deps.slack.update(deps.channel, m.ts, onlineNotice(beat, deps.clock()));
      log(`closed the offline notice ${m.ts}`);
    }
  };

  const rearm = async (): Promise<void> => {
    const now = deps.clock();
    const fresh = await deps.slack.schedule(deps.channel, Math.floor((now + leadMs) / 1000), offlineNotice(now));
    const listed = await deps.slack.scheduled(deps.channel);
    // If the list cannot see what we just armed, it cannot see the old ones
    // either, and every tick would add a notice that fires while we are online.
    if (!listed.some((s) => s.id === fresh)) {
      await deps.slack.unschedule(deps.channel, fresh);
      throw new Error(`the armed notice ${fresh} is not in the scheduled list - is the channel an id?`);
    }
    // One failed cancel (a notice Slack is posting right now) must not stop
    // the others, nor the close below.
    for (const s of listed) {
      if (s.id === fresh || !isArmedNotice(s.text)) continue;
      await deps.slack.unschedule(deps.channel, s.id).catch((e: unknown) => log(`could not cancel ${s.id}: ${message(e)}`));
    }
  };

  const once = async (): Promise<void> => {
    try {
      await rearm();
      await closeOpenNotices();
      if (failing) log("back online, re-armed");
      failing = false;
    } catch (e) {
      if (!failing) log(`tick failed, the armed notice stands: ${message(e)}`);
      failing = true;
    }
  };

  const cancelAll = async (): Promise<void> => {
    for (const s of await deps.slack.scheduled(deps.channel)) {
      if (!isArmedNotice(s.text)) continue;
      await deps.slack.unschedule(deps.channel, s.id).catch((e: unknown) => log(`could not cancel ${s.id}: ${message(e)}`));
    }
  };

  return {
    tick: async () => {
      if (inFlight || stopped) return;
      inFlight = once().finally(() => {
        inFlight = undefined;
      });
      await inFlight;
    },
    disarm: async () => {
      stopped = true;
      const work = (async () => {
        await inFlight;
        await cancelAll();
      })().catch((e: unknown) => log(`could not disarm: ${message(e)}`));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          log("disarm timed out, an armed notice may still post");
          resolve();
        }, deps.disarmWaitMs ?? DISARM_WAIT_MS);
      });
      await Promise.race([work, timeout]);
      clearTimeout(timer);
    },
  };
};
