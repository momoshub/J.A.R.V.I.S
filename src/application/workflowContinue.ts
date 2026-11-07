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
 *
 * These steps are the worker's. People in the thread talk to the front on its
 * own queue; what the front passes on (`steerWorker`) waits on the row for the
 * worker's next step, or starts one if the worker is idle.
 */
import {
  AUTO_CONTINUE_CAP,
  CONTINUE_DELAY_MS,
  CONTINUE_MESSAGE,
  pausedNotice,
} from "../domain/workflowContinue.ts";
import type { Clock } from "./ports.ts";
import type { Workflow } from "../domain/types.ts";
import type { ThreadQueue } from "./threadQueue.ts";
import type { RunRegistry } from "./runRegistry.ts";
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
  /** To tell whether the worker is busy before a steer kicks a step. */
  threadQueue?: ThreadQueue;
  runs?: RunRegistry;
  /**
   * True while a restart waits for running turns. A step is then left pending
   * on its row instead of started, and the next process resumes it at boot.
   */
  draining?: () => boolean;
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
  // Leave it on the row: `resumeContinues` starts it in the next process.
  if (deps.draining?.()) return false;
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

export type SteerOutcome =
  /** The worker is mid-step or has one queued: it gets these at the next one. */
  | "queued"
  /** The worker was idle, so a step was started for them. */
  | "kicked"
  /** The workflow ended meanwhile; nothing was passed on. */
  | "stopped";

/**
 * Hand instructions from the front to the worker. They wait on the row, so a
 * restart does not lose them, and the worker's next step carries them. If the
 * worker is idle - finished, blocked on a question, paused at the cap - a step
 * is started right away, as the person who steered it. A steer is a human
 * driving the task, so the count of steps on its own starts again.
 */
export const steerWorker = (
  deps: ContinueDeps,
  workflow: Workflow,
  by: string,
  texts: readonly string[],
  workerKey: string,
): SteerOutcome => {
  const repo = deps.workflows;
  const live = repo?.get(workflow.id);
  if (!repo || !live || live.status !== "active") return "stopped";
  const at = deps.clock();
  repo.addSteers(live.id, texts.map((text) => ({ by, text, at })));
  repo.resetAutoTurns(live.id);
  const busy =
    (deps.threadQueue?.depth(workerKey) ?? 0) > 0 ||
    (deps.runs?.inThread(workerKey).length ?? 0) > 0 ||
    live.continueAs !== undefined;
  if (busy || !deps.runTurn) return "queued";
  const seq = repo.requestContinue(live.id, by, at);
  if (seq === undefined) return "stopped";
  later(deps, () => kickContinue(deps, live.id, seq), 0);
  return "kicked";
};

export type AfterTurn = "continue" | "paused" | "idle";

/**
 * After a workflow turn finished cleanly: queue the next step if it asked for
 * one, pause once it has carried on alone `AUTO_CONTINUE_CAP` times, and do
 * nothing if the workflow was stopped while the turn ran. An aborted or failed
 * turn never reaches here - its caller does not ask.
 *
 * Steers that arrived while the step ran win over all of that: the step could
 * not see them, so the next one runs to deliver them, whatever this one said.
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
  if (live.steers.length > 0 && deps.runTurn) {
    repo.resetAutoTurns(live.id);
    const seq = repo.requestContinue(live.id, actorId, deps.clock());
    if (seq === undefined) return "idle";
    later(deps, () => kickContinue(deps, live.id, seq));
    return "continue";
  }
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
 * so the thread shows where it stopped and a human picks it up - unless
 * steers are still waiting for the worker: those were passed on to be acted
 * on, so a step starts to deliver them, as whoever gave the last one.
 */
export const resumeContinues = (deps: ContinueDeps, delayMs = CONTINUE_DELAY_MS): number => {
  let resumed = 0;
  for (const w of deps.workflows?.listActive() ?? []) {
    if (w.continueAs) {
      later(deps, () => kickContinue(deps, w.id, w.continueSeq), delayMs);
      resumed += 1;
      continue;
    }
    const by = w.steers.at(-1)?.by;
    if (!by || !deps.runTurn) continue;
    const seq = deps.workflows?.requestContinue(w.id, by, deps.clock());
    if (seq === undefined) continue;
    later(deps, () => kickContinue(deps, w.id, seq), delayMs);
    resumed += 1;
  }
  return resumed;
};
