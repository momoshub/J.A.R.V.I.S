/**
 * Workflow auto-continue - queueing the next step without a human.
 *
 * A turn that ends with `[continue]` gets its next step started by the bot,
 * through `runTurn`: the ordinary respond path, so the same thread queue, the
 * same session and the same role checks as the person who drove it. A
 * shortcut would have its own idea of who may steer the task and could run
 * beside a human's turn instead of after it.
 *
 * The pending step lives on the workflow row, not only in a timer, so a
 * restart between two steps picks the chain back up (`resumeContinues`).
 */
import {
  AUTO_CONTINUE_CAP,
  CONTINUE_DELAY_MS,
  CONTINUE_MESSAGE,
  pausedNotice,
} from "../domain/workflowContinue.ts";
import type { Clock } from "./ports.ts";
import type { Workflow } from "../domain/types.ts";
import type { WorkflowRepo } from "../infrastructure/db/workflowRepo.ts";

export type ContinueTurnRequest = {
  channelId: string;
  threadTs: string;
  slackUserId: string;
  text: string;
  keepSession?: boolean;
  /** A step the bot started itself, not a human message. */
  autoContinue?: boolean;
};

export type ContinueDeps = {
  workflows?: WorkflowRepo;
  clock: Clock;
  /** The ordinary turn path, wired at the composition root. */
  runTurn?: (req: ContinueTurnRequest) => Promise<void>;
  slack?: { post: (channel: string, text: string, threadTs?: string) => Promise<unknown> };
  /** Timer for the next step; injected so tests need not wait. */
  continueTimer?: (fn: () => void, ms: number) => void;
};

const defaultTimer = (fn: () => void, ms: number): void => {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
};

const later = (deps: ContinueDeps, fn: () => Promise<unknown>, ms = CONTINUE_DELAY_MS): void =>
  (deps.continueTimer ?? defaultTimer)(() => {
    // A timer callback has nobody to hand a rejection to; never let one out.
    void fn().catch((e: unknown) =>
      console.error(`[workflow] next step failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }, ms);

/**
 * Start a pending step, if it is still wanted. Claiming it is one guarded
 * update, so a stale timer, a stopped workflow or a human who spoke since all
 * leave it a no-op.
 */
export const kickContinue = async (deps: ContinueDeps, id: number, seq: number): Promise<boolean> => {
  const w = deps.workflows?.get(id);
  if (!w || w.status !== "active" || !w.continueAs || !deps.runTurn) return false;
  const as = w.continueAs;
  if (!deps.workflows?.takeContinue(id, seq, deps.clock())) return false;
  await deps.runTurn({
    channelId: w.channelId,
    threadTs: w.threadTs,
    slackUserId: as,
    text: CONTINUE_MESSAGE,
    keepSession: true,
    autoContinue: true,
  });
  return true;
};

/** A human message is about to drive the workflow: no pending step, count restarts. */
export const humanSteers = (deps: ContinueDeps, workflow: Workflow): void => {
  deps.workflows?.humanTurn(workflow.id);
};

export type AfterTurn = "continue" | "paused" | "idle";

/**
 * After a workflow turn finished cleanly: queue the next step if it asked for
 * one, pause once it has carried on alone `AUTO_CONTINUE_CAP` times, and do
 * nothing if the workflow was stopped while the turn ran. An aborted or failed
 * turn never reaches here - its caller does not ask.
 */
export const afterWorkflowTurn = async (
  deps: ContinueDeps,
  workflow: Workflow,
  actorId: string,
  wantsContinue: boolean,
  prefix?: string,
): Promise<AfterTurn> => {
  const repo = deps.workflows;
  const live = repo?.get(workflow.id);
  if (!repo || !live || live.status !== "active") return "idle";
  if (!wantsContinue || !deps.runTurn) {
    repo.clearContinue(live.id);
    return "idle";
  }
  if (live.autoTurns >= AUTO_CONTINUE_CAP) {
    repo.clearContinue(live.id);
    try {
      await deps.slack?.post(live.channelId, pausedNotice(AUTO_CONTINUE_CAP, prefix), live.threadTs);
    } catch {
      // a notice that cannot be posted is not worth failing the turn over
    }
    return "paused";
  }
  const seq = repo.requestContinue(live.id, actorId, deps.clock());
  if (seq === undefined) return "idle";
  later(deps, () => kickContinue(deps, live.id, seq));
  return "continue";
};

/**
 * On boot: restart every chain a restart cut between two steps. A step that
 * was already running when the process died is not resumed - it was claimed,
 * so the thread shows where it stopped and a human picks it up.
 */
export const resumeContinues = (deps: ContinueDeps, delayMs = CONTINUE_DELAY_MS): number => {
  const pending = (deps.workflows?.listActive() ?? []).filter((w) => w.continueAs);
  for (const w of pending) later(deps, () => kickContinue(deps, w.id, w.continueSeq), delayMs);
  return pending.length;
};
