/**
 * The stuck-work sweeper: every `SWEEP_TICK_MS`, outside any turn, it asks for
 * dispatched Orca tasks whose worker is gone and quiet PRs on the bot's own
 * repo, and DMs the owner what is new (see domain/stuckWork.ts).
 *
 * No model, no turn, no queue slot. What was already reported is kept in
 * settings with when, so the same item is not repeated for `REPEAT_AFTER_MS`
 * and a restart does not report everything again. The record is saved only
 * once the DM landed: a failed post is retried on the next sweep, not lost.
 */
import { parseSeen, REPEAT_AFTER_MS, stuckDm, toReport, type StuckWork } from "../domain/stuckWork.ts";
import type { Clock } from "./ports.ts";

export type StuckSweeperDeps = {
  readonly clock: Clock;
  readonly scan: () => Promise<StuckWork>;
  readonly settings: { get: (key: string) => string | undefined; set: (key: string, value: string) => void };
  /** Settings key the reported items are kept under. */
  readonly seenKey: string;
  readonly ownerSlackId: string;
  /** DM the owner; resolves truthy once it landed. */
  readonly postDm: (userId: string, text: string) => Promise<unknown>;
  /** The workspace domain for thread links, from one permalink. */
  readonly team?: (work: StuckWork) => Promise<string | undefined>;
  readonly prefix: string;
  readonly repeatMs?: number;
  readonly log?: (msg: string) => void;
};

export type StuckSweeper = {
  /** One sweep. Never throws, never overlaps itself. */
  tick: () => Promise<void>;
};

export const createStuckSweeper = (deps: StuckSweeperDeps): StuckSweeper => {
  let running = false;

  const once = async (): Promise<void> => {
    const work = await deps.scan();
    const now = deps.clock();
    const { fresh, seen } = toReport(work, parseSeen(deps.settings.get(deps.seenKey)), now, deps.repeatMs ?? REPEAT_AFTER_MS);
    const text = stuckDm(fresh, now, deps.prefix, await deps.team?.(fresh).catch(() => undefined));
    if (!text) return;
    const posted = await deps.postDm(deps.ownerSlackId, text);
    if (!posted) {
      deps.log?.("could not DM the owner; trying again next sweep");
      return;
    }
    deps.settings.set(deps.seenKey, JSON.stringify(seen));
    deps.log?.(`reported ${fresh.tasks.length} stuck task(s) and ${fresh.prs.length} quiet PR(s)`);
  };

  return {
    tick: async () => {
      if (running) return;
      running = true;
      try {
        await once();
      } catch (e) {
        deps.log?.(`sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        running = false;
      }
    },
  };
};
