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
  readonly log?: (msg: string) => void;
};

export type OfflineAlarm = {
  /** Close, re-arm, cancel. Never throws, safe on a timer. */
  tick: () => Promise<void>;
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const createOfflineAlarm = (deps: OfflineAlarmDeps): OfflineAlarm => {
  const log = deps.log ?? (() => {});
  const leadMs = deps.leadMs ?? OFFLINE_ALARM_LEAD_MS;
  let running = false;
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
    for (const s of await deps.slack.scheduled(deps.channel)) {
      if (s.id !== fresh && isArmedNotice(s.text)) await deps.slack.unschedule(deps.channel, s.id);
    }
  };

  return {
    tick: async () => {
      if (running) return;
      running = true;
      try {
        await rearm();
        await closeOpenNotices();
        if (failing) log("back online, re-armed");
        failing = false;
      } catch (e) {
        if (!failing) log(`tick failed, the armed notice stands: ${message(e)}`);
        failing = true;
      } finally {
        running = false;
      }
    },
  };
};
