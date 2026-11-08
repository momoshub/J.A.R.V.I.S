/**
 * Orca question bridge - a worker's `orca orchestration ask` comes back to the
 * Slack thread that started the worker, as a turn that answers it.
 *
 * A turn is `claude -p` and Orca cannot wake it; the coordinator Orca knows is
 * the bot's own terminal, a bare shell. So a worker that asked a question
 * waited forever. Two halves fix it:
 *
 * - `observe` sits on the tool-trace sink: when a turn's Bash call ran
 *   `orca orchestration worker-start` and printed a worker back, its dispatch
 *   and Run ids are linked to that turn's thread, durably.
 * - `tick` reads each recently linked Run's mailbox, and hands every question
 *   still waiting to the thread through the ordinary turn path (same queue,
 *   same session, same role checks), as whoever started the worker.
 *
 * Exactly once: the question's row is written before its turn starts, so a
 * second tick never delivers it again; a row a dead process left half-done is
 * delivered again only while the question is still unanswered and its worker
 * still running, at most `MAX_ATTEMPTS` times. Polling, like the review inbox:
 * nothing to install in Orca, and seconds of delay on a blocked worker is nothing.
 */
import {
  answeredIn,
  questionsIn,
  questionTurnText,
  workerLinksIn,
  type OrcaQuestion,
} from "../domain/orcaQuestions.ts";
import { bashCommand, orcaWorkerLiveness, runsOrcaWorkerStart } from "../domain/threadBackground.ts";
import type { OrcaQuestionRepo } from "../infrastructure/db/orcaQuestionRepo.ts";
import type { BillingContext, Clock, ToolTrace } from "./ports.ts";

/** How often the mailboxes are read. */
export const ORCA_QUESTION_POLL_MS = 30_000;
/** How long after a worker started its Run's mailbox is still read. */
export const ORCA_QUESTION_WINDOW_MS = 3 * 24 * 60 * 60_000;
/** Deliveries of one question before the bridge stops trying (each one cut short). */
export const MAX_ATTEMPTS = 3;
/** Runs read per poll, newest first; past this the oldest are skipped (and it says so). */
export const MAX_RUNS_PER_POLL = 100;
/** Bash calls whose result has not come back yet, kept at most. */
const MAX_PENDING_CALLS = 500;

/** One `orca` call: exit code and stdout. Never throws. */
export type OrcaCall = (args: readonly string[]) => Promise<{ code: number; stdout: string }>;

export type OrcaQuestionDeps = {
  repo: OrcaQuestionRepo;
  clock: Clock;
  orca: OrcaCall;
  /** Whether the bot has its own Orca terminal now; without one a turn cannot reply. */
  ready: () => Promise<boolean>;
  /** Start the question turn in the thread. Resolves when the turn is done. */
  runTurn: (req: {
    channelId: string;
    threadTs: string;
    slackUserId: string;
    text: string;
    keepSession?: boolean;
    unprompted?: boolean;
    /** In a workflow thread, the worker's session answers, not the front. */
    workerLane?: boolean;
  }) => Promise<void>;
  /** Whether whoever started the worker may still run turns. */
  mayRun: (slackUserId: string) => boolean;
  log?: (msg: string) => void;
  onError?: (e: unknown) => void;
};

export type OrcaQuestionBridge = {
  /** Feed every tool trace through here; links the workers a thread starts. Never throws. */
  observe: (trace: ToolTrace, bill: BillingContext | undefined) => void;
  /** Read the mailboxes and deliver what is waiting. Safe on a timer. */
  tick: () => Promise<void>;
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const createOrcaQuestionBridge = (deps: OrcaQuestionDeps): OrcaQuestionBridge => {
  const log = deps.log ?? (() => {});
  const pending = new Map<string, { command: string; bill: BillingContext }>();
  // Questions whose turn this process started and is still running.
  const inFlight = new Set<string>();
  let running = false;
  let lastPoll = Number.NEGATIVE_INFINITY;

  const observe = (trace: ToolTrace, bill: BillingContext | undefined): void => {
    try {
      if (trace.kind === "call") {
        if (!bill?.channel || !bill.threadTs) return;
        const command = bashCommand(trace.name, trace.input);
        if (!command || !runsOrcaWorkerStart(command)) return;
        if (pending.size >= MAX_PENDING_CALLS) {
          const oldest = pending.keys().next().value;
          if (oldest !== undefined) pending.delete(oldest);
        }
        pending.set(trace.id, { command, bill });
        return;
      }
      const call = pending.get(trace.id);
      if (!call) return;
      pending.delete(trace.id);
      if (trace.isError) return;
      const { channel, threadTs, actor } = call.bill;
      if (!channel || !threadTs) return;
      const thread = { channelId: channel, threadTs, slackUserId: actor };
      const at = deps.clock();
      for (const l of workerLinksIn(trace.output)) {
        deps.repo.link(l.dispatchId, thread, at);
        deps.repo.link(l.runId, thread, at);
        log(`worker ${l.dispatchId} (run ${l.runId}) belongs to ${channel}/${threadTs}`);
      }
    } catch (e) {
      // A trace sink that throws would take the turn's stream down with it.
      log(`could not link a worker: ${message(e)}`);
    }
  };

  /** Still waiting on its coordinator: unanswered, and the worker still running. Undefined = cannot tell. */
  const stillWaiting = async (q: OrcaQuestion): Promise<"waiting" | "answered" | "closed" | undefined> => {
    const box = await deps.orca(["orchestration", "inbox", "--terminal", `dispatch:${q.dispatchId}`, "--limit", "100", "--full", "--json"]);
    const answered = answeredIn(box.stdout, q.id);
    if (answered === undefined) return undefined;
    if (answered) return "answered";
    const shown = await deps.orca(["orchestration", "worker-show", "--dispatch", q.dispatchId, "--json"]);
    return orcaWorkerLiveness(shown.stdout) === "gone" ? "closed" : "waiting";
  };

  const deliver = (q: OrcaQuestion, thread: { channelId: string; threadTs: string; slackUserId: string }): void => {
    inFlight.add(q.id);
    const done = (): void => void inFlight.delete(q.id);
    try {
      void deps
        .runTurn({
          channelId: thread.channelId,
          threadTs: thread.threadTs,
          slackUserId: thread.slackUserId,
          text: questionTurnText(q),
          // The session that started the worker holds the context to answer with.
          keepSession: true,
          // Nobody typed it: no "yours is next" notice behind a running turn.
          unprompted: true,
          // A workflow's worker started it, and only its session (with full
          // tools) can run the reply - the front cannot run `orca`.
          workerLane: true,
        })
        .then(() => deps.repo.settle(q.id, "delivered", deps.clock()))
        // Left `delivering`: the next tick tries again while it is still unanswered.
        .catch((e) => log(`question ${q.id} could not start its turn: ${message(e)}`))
        .finally(done);
    } catch (e) {
      log(`question ${q.id} could not start its turn: ${message(e)}`);
      done();
    }
  };

  const one = async (q: OrcaQuestion): Promise<void> => {
    if (inFlight.has(q.id)) return;
    const row = deps.repo.question(q.id);
    if (row && row.state !== "delivering") return;
    const thread = deps.repo.threadOf(q.dispatchId) ?? deps.repo.threadOf(q.runId);
    if (!thread) return;
    const state = await stillWaiting(q);
    if (state === undefined) return;
    const now = deps.clock();
    if (state !== "waiting") {
      if (row) deps.repo.settle(q.id, state, now);
      else deps.repo.record({ messageId: q.id, runId: q.runId, dispatchId: q.dispatchId }, thread, state, now);
      return;
    }
    if (!deps.mayRun(thread.slackUserId)) {
      if (row) deps.repo.settle(q.id, "refused", now);
      else deps.repo.record({ messageId: q.id, runId: q.runId, dispatchId: q.dispatchId }, thread, "refused", now);
      log(`question ${q.id} not delivered: ${thread.slackUserId} may no longer run turns`);
      return;
    }
    if (row) {
      // A delivery a previous process (or a failed start) left behind.
      if (row.attempts >= MAX_ATTEMPTS) {
        deps.repo.settle(q.id, "gave_up", now);
        log(`question ${q.id} gave up after ${row.attempts} deliveries`);
        return;
      }
      deps.repo.retry(q.id, now);
    } else if (!deps.repo.record({ messageId: q.id, runId: q.runId, dispatchId: q.dispatchId }, thread, "delivering", now)) {
      return;
    }
    log(`question ${q.id} from ${q.dispatchId} -> ${thread.channelId}/${thread.threadTs}`);
    deliver(q, thread);
  };

  const tick = async (): Promise<void> => {
    if (running) return;
    const now = deps.clock();
    if (now - lastPoll < ORCA_QUESTION_POLL_MS) return;
    lastPoll = now;
    running = true;
    try {
      const runs = deps.repo.runsSince(now - ORCA_QUESTION_WINDOW_MS, MAX_RUNS_PER_POLL);
      if (runs.length === 0 || !(await deps.ready())) return;
      if (runs.length >= MAX_RUNS_PER_POLL) log(`${runs.length} Runs linked in the window; only the newest ${MAX_RUNS_PER_POLL} are read`);
      for (const runId of runs) {
        const box = await deps.orca(["orchestration", "inbox", "--terminal", `run:${runId}`, "--limit", "100", "--full", "--json"]);
        const questions = questionsIn(box.stdout, runId);
        if (!questions) continue;
        for (const q of questions) {
          try {
            await one(q);
          } catch (e) {
            // One bad question must never keep the others from their threads.
            log(`question ${q.id} failed: ${message(e)}`);
          }
        }
      }
    } catch (e) {
      log(`poll failed: ${message(e)}`);
      deps.onError?.(e);
    } finally {
      running = false;
    }
  };

  return { observe, tick };
};
