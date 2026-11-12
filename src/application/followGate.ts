/**
 * The per-thread buffer in front of a followed thread's main turn.
 *
 * The rules (windows, cap, verdicts) are pure and live in `domain/followGate.ts`;
 * this is the part that owns a timer per thread and asks the cheap model when a
 * window ends. The clock, the timers and the model are all injected, so a test
 * drives it by moving a fake clock and never sleeps.
 *
 * `submit` returns a promise that settles only when the batch the message
 * joined has been dealt with: skipped, or answered. The caller holds its inbox
 * row for exactly that long, which is the persistence: a row stays `running`
 * while its message is buffered, so a restart redelivers it (`recoverFor`) and
 * the message is buffered again, instead of living only in memory.
 */
import {
  addToBatch,
  capOf,
  failOpen,
  gateLogLine,
  outcomeOf,
  type Batch,
  type BufferedMessage,
  type GateDecision,
  type GateSettings,
} from "../domain/followGate.ts";

export type GateKey = { readonly channel: string; readonly threadTs: string };

/** Injectable timers, so nothing in a test sleeps. */
export type GateTimers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const realTimers: GateTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** How long the gate model gets before the batch is simply answered. */
export const GATE_TIMEOUT_MS = 20_000;

export type FollowGateDeps<T extends BufferedMessage> = {
  settings: () => GateSettings;
  now: () => number;
  /** Ask the cheap model about a batch. May throw; that fails open. */
  decide: (q: GateKey & { items: readonly T[] }) => Promise<GateDecision>;
  /** Run the main turn on the whole batch, oldest first. */
  run: (q: GateKey & { items: readonly T[] }) => Promise<void>;
  log: (line: string) => void;
  timers?: GateTimers;
  gateTimeoutMs?: number;
};

type Entry<T extends BufferedMessage> = {
  batch: Batch<T>;
  waiters: (() => void)[];
  timer?: unknown;
  /** The gate is being asked right now. */
  asking: boolean;
  /** A message arrived while it was: the answer is about an older batch. */
  stale: boolean;
};

export const createFollowGate = <T extends BufferedMessage>(deps: FollowGateDeps<T>) => {
  const timers = deps.timers ?? realTimers;
  const timeoutMs = deps.gateTimeoutMs ?? GATE_TIMEOUT_MS;
  const entries = new Map<string, Entry<T>>();
  const keyOf = (k: GateKey): string => `${k.channel}:${k.threadTs}`;

  const arm = (k: GateKey, e: Entry<T>): void => {
    if (e.timer !== undefined) timers.clear(e.timer);
    e.timer = timers.set(() => void fire(k), Math.max(0, e.batch.dueAt - deps.now()));
  };

  /** Ask the model, bounded; any failure is a `reply`. */
  const ask = async (k: GateKey, items: readonly T[]): Promise<GateDecision> => {
    let handle: unknown;
    const timeout = new Promise<GateDecision>((resolve) => {
      handle = timers.set(() => resolve(failOpen(`gate timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    });
    try {
      return await Promise.race([deps.decide({ ...k, items }), timeout]);
    } catch (err) {
      return failOpen(`gate failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      timers.clear(handle);
    }
  };

  const settle = (e: Entry<T>): void => {
    for (const done of e.waiters) done();
  };

  const fire = async (k: GateKey): Promise<void> => {
    const id = keyOf(k);
    const e = entries.get(id);
    if (!e || e.asking) return;
    e.timer = undefined;
    const settings = deps.settings();
    const sent = e.batch;
    const size = sent.items.length;

    // Switched off while messages were waiting: no gate, just answer them.
    let decision: GateDecision = failOpen("gate off");
    if (settings.enabled) {
      e.asking = true;
      e.stale = false;
      decision = await ask(k, sent.items);
      e.asking = false;
    }

    // Somebody wrote while the model was reading: its answer is about a batch
    // that no longer exists. The new message already restarted the window.
    if (e.stale) {
      deps.log(gateLogLine({ ...k, size, decision, note: "superseded by a newer message" }));
      arm(k, e);
      return;
    }

    const outcome = outcomeOf(decision.verdict, e.batch, deps.now(), settings);
    if (outcome.action === "wait") {
      deps.log(gateLogLine({ ...k, size, decision, note: "window extended" }));
      e.batch = outcome.batch;
      arm(k, e);
      return;
    }

    const atCap = decision.verdict === "wait";
    deps.log(
      gateLogLine({
        ...k,
        size,
        decision: atCap ? { ...decision, verdict: "reply" } : decision,
        ...(atCap
          ? { note: `wait at ${deps.now() >= capOf(e.batch, settings) ? "the cap" : "its second ask"}, answering` }
          : {}),
      }),
    );

    // Detached before the turn runs, so a message that lands during it opens
    // the next batch instead of joining one already answered.
    entries.delete(id);
    if (outcome.action === "reply") {
      await deps.run({ ...k, items: e.batch.items }).catch((err: unknown) => {
        deps.log(`follow gate turn failed channel=${k.channel} thread=${k.threadTs}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    settle(e);
  };

  return {
    /**
     * Buffer a message. Settles when its batch is skipped or answered, so the
     * caller can keep its inbox row open until then.
     */
    submit: (k: GateKey, msg: T): Promise<void> =>
      new Promise<void>((resolve) => {
        const id = keyOf(k);
        const e = entries.get(id);
        const batch = addToBatch(e?.batch, msg, deps.now(), deps.settings());
        if (e) {
          e.batch = batch;
          e.waiters.push(resolve);
          if (e.asking) e.stale = true;
          // While the model is reading, the timer is not the one to move.
          if (!e.asking) arm(k, e);
          return;
        }
        const fresh: Entry<T> = { batch, waiters: [resolve], asking: false, stale: false };
        entries.set(id, fresh);
        arm(k, fresh);
      }),
    /** Threads with messages waiting, for tests and diagnostics. */
    pending: (): number => entries.size,
  };
};

export type FollowGate<T extends BufferedMessage> = ReturnType<typeof createFollowGate<T>>;
