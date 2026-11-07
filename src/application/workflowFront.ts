/**
 * The front of a workflow - what a person in the thread talks to.
 *
 * The worker session does the task on the thread's own queue key, one step at
 * a time. A person's message runs on a separate key (`frontKeyOf`) against a
 * front session of its own, so it is answered while a step is still running.
 * The front is told where the work is through a digest built right before its
 * turn, from the run registry, the workflow row and the thread's tool trace.
 */
import { buildDigest, DIGEST_CALLS, type DigestCall, type WorkerState } from "../domain/workflowFront.ts";
import type { Workflow } from "../domain/types.ts";
import type { Clock } from "./ports.ts";
import type { RunRegistry } from "./runRegistry.ts";
import type { ThreadQueue } from "./threadQueue.ts";

export type FrontDeps = {
  clock: Clock;
  runs?: RunRegistry;
  threadQueue?: ThreadQueue;
  /**
   * The worker's newest tool calls in a thread, oldest first. Read from the
   * per-thread trace log; wired at the composition root.
   */
  workerCalls?: (channelId: string, threadTs: string, limit: number) => readonly DigestCall[];
};

/** Is the worker mid-step, between steps, or idle? */
export const workerStateOf = (deps: FrontDeps, workflow: Workflow, workerKey: string): WorkerState => {
  const running = deps.runs?.current(workerKey);
  if (running) return { state: "running", since: running.startedAt };
  const waiting = (deps.runs?.inThread(workerKey).length ?? 0) > 0 || (deps.threadQueue?.depth(workerKey) ?? 0) > 0;
  if (waiting || workflow.continueAs) return { state: "queued" };
  return { state: "idle" };
};

/** The digest the front gets with a message: small, and built right now. */
export const frontDigest = (deps: FrontDeps, workflow: Workflow, workerKey: string): string => {
  let calls: readonly DigestCall[] = [];
  try {
    calls = deps.workerCalls?.(workflow.channelId, workflow.threadTs, DIGEST_CALLS) ?? [];
  } catch {
    // a digest without the tool calls still answers "where are we"
  }
  return buildDigest({
    now: deps.clock(),
    worker: workerStateOf(deps, workflow, workerKey),
    turns: workflow.turns,
    autoTurns: workflow.autoTurns,
    steers: workflow.steers,
    replies: workflow.workerReplies,
    calls,
  });
};
