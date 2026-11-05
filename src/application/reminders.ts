/**
 * The thing that posts reminders when they come due.
 *
 * It shares the watcher's reason for living outside every turn - nothing here
 * needs a model - and is simpler still: there is no predicate, only a time,
 * and the whole job when it arrives is one message in the right place.
 */
import { reminderMessage } from "../domain/reminder.ts";
import type { ReminderRepo } from "../infrastructure/db/reminderRepo.ts";
import type { Clock } from "./ports.ts";

/** Failed posts before a reminder is given up on. */
export const MAX_POST_ATTEMPTS = 5;
/** How long to wait before trying a failed post again. */
export const RETRY_MS = 60_000;

export type ReminderSenderDeps = {
  reminders: ReminderRepo;
  clock: Clock;
  /** Post a message; an empty thread means the channel itself. */
  post: (channelId: string, text: string, threadTs?: string) => Promise<void>;
  log?: (msg: string) => void;
};

export type ReminderSender = {
  /** Post everything that is due. Safe to call on a timer. */
  tick: () => Promise<void>;
};

export const createReminderSender = (deps: ReminderSenderDeps): ReminderSender => {
  const log = deps.log ?? (() => {});
  // Same guard as the watcher: an overrunning tick must not post a reminder twice.
  let running = false;

  return {
    tick: async () => {
      if (running) return;
      running = true;
      try {
        for (const r of deps.reminders.due(deps.clock())) {
          try {
            await deps.post(r.channelId, reminderMessage(r.targets, r.text, r.createdBy), r.threadTs || undefined);
            deps.reminders.settle(r.id, "sent", deps.clock());
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log(`reminder ${r.id} could not be posted: ${msg}`);
            if (r.attempts + 1 >= MAX_POST_ATTEMPTS) deps.reminders.settle(r.id, "failed", deps.clock(), msg);
            else deps.reminders.retry(r.id, deps.clock() + RETRY_MS, deps.clock(), msg);
          }
        }
      } finally {
        running = false;
      }
    },
  };
};
