/**
 * Orca questions - the pure half of "a worker asked its coordinator, so put
 * the question to the Slack thread that started it".
 *
 * A worker that runs `orca orchestration ask` waits for its coordinator. When
 * a turn started the worker, that coordinator is the bot's own Orca terminal -
 * a bare shell nobody reads - so the question sat in the Run's mailbox and the
 * worker waited forever (a PR reviewer did, for a whole afternoon). The bridge
 * remembers which thread started each worker, reads the Run's mailbox on a
 * timer, and hands every unanswered question to that thread as a turn, which
 * answers it with `orca orchestration reply`.
 *
 * Nothing here runs `orca` or touches the database. It reads what a
 * `worker-start` printed, what a mailbox holds, and writes the turn's text.
 */

/** One worker a thread started, as `worker-start --json` printed it. */
export type WorkerLink = { readonly runId: string; readonly dispatchId: string };

/** A `worker-start` result: `{"dispatchId":"ctx_..","taskId":..,"runId":"run_.."}`, in either order. */
const LINK_DISPATCH_FIRST = /"dispatchId"\s*:\s*"(ctx_[0-9a-f]{6,})"[^{}]*?"runId"\s*:\s*"(run_[0-9a-f]{6,})"/g;
const LINK_RUN_FIRST = /"runId"\s*:\s*"(run_[0-9a-f]{6,})"[^{}]*?"dispatchId"\s*:\s*"(ctx_[0-9a-f]{6,})"/g;

/**
 * The workers one `worker-start` call's output says it started, each once.
 * Both ids must sit in the same JSON object, so a stray id elsewhere in the
 * output (a `task-list` chained on, a log line) is never paired with a Run.
 */
export const workerLinksIn = (output: string): WorkerLink[] => {
  const seen = new Set<string>();
  const out: WorkerLink[] = [];
  const add = (runId: string, dispatchId: string): void => {
    if (seen.has(dispatchId)) return;
    seen.add(dispatchId);
    out.push({ runId, dispatchId });
  };
  for (const m of output.matchAll(LINK_DISPATCH_FIRST)) add(m[2] ?? "", m[1] ?? "");
  for (const m of output.matchAll(LINK_RUN_FIRST)) add(m[1] ?? "", m[2] ?? "");
  return out.filter((l) => l.runId && l.dispatchId);
};

/** A question a worker put to its Run's coordinator. */
export type OrcaQuestion = {
  readonly id: string;
  readonly runId: string;
  readonly dispatchId: string;
  readonly taskId: string;
  readonly question: string;
  readonly options: readonly string[];
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const parse = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
};

/** The messages of an `inbox --full --json` answer, or undefined when it is not one. */
const messagesOf = (stdout: string): Record<string, unknown>[] | undefined => {
  const r = parse(stdout);
  if (!isRecord(r) || r.ok !== true || !isRecord(r.result) || !Array.isArray(r.result.messages)) return undefined;
  return r.result.messages.filter(isRecord);
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The questions in a Run's mailbox (`inbox --terminal run:<id> --full --json`),
 * oldest first. Only `question` messages addressed to this Run count. Undefined
 * when the output is not a mailbox at all - a failed read is not "no questions".
 */
export const questionsIn = (stdout: string, runId: string): OrcaQuestion[] | undefined => {
  const messages = messagesOf(stdout);
  if (!messages) return undefined;
  const out: OrcaQuestion[] = [];
  for (const m of messages) {
    if (m.type !== "question" || m.to_handle !== `run:${runId}`) continue;
    const id = str(m.id);
    if (!id) continue;
    const payload = parse(str(m.payload));
    const p = isRecord(payload) ? payload : {};
    const fromDispatch = str(m.from_handle).startsWith("dispatch:") ? str(m.from_handle).slice("dispatch:".length) : "";
    const dispatchId = str(p.dispatchId) || fromDispatch;
    if (!dispatchId) continue;
    out.push({
      id,
      runId,
      dispatchId,
      taskId: str(p.taskId),
      question: str(p.question) || str(m.body),
      options: Array.isArray(p.options) ? p.options.filter((o): o is string => typeof o === "string") : [],
    });
  }
  // The mailbox lists newest first; questions go out in the order they were asked.
  return out.reverse();
};

/**
 * Whether a worker's mailbox (`inbox --terminal dispatch:<id> --full --json`)
 * already holds an answer to this question: any other message threaded on it.
 * Undefined when the output is not a mailbox.
 */
export const answeredIn = (stdout: string, questionId: string): boolean | undefined => {
  const messages = messagesOf(stdout);
  if (!messages) return undefined;
  return messages.some((m) => m.thread_id === questionId && m.id !== questionId);
};

/** Longest question text carried into a turn. */
export const QUESTION_CHARS = 4_000;

const clip = (text: string): string =>
  text.length <= QUESTION_CHARS ? text : `${text.slice(0, QUESTION_CHARS)}…[clipped ${text.length - QUESTION_CHARS} chars]`;

/** The tag a question turn opens with, so the thread and the prompt can tell it apart. */
export const ORCA_QUESTION_TAG = "[orca question]";

/**
 * The turn that puts a question to the thread. It must end in a reply: the
 * worker waits on nothing else, and nobody else is reading. So it never asks
 * the thread and waits - it answers from what the thread knows, or picks the
 * safe option and says so.
 */
export const questionTurnText = (q: OrcaQuestion): string => {
  const options = q.options.length > 0 ? `\nOptions it offered: ${q.options.join(" | ")}` : "";
  return `${ORCA_QUESTION_TAG} An Orca worker this thread started is blocked on a question to you (question \`${q.id}\`, run \`${q.runId}\`, dispatch \`${q.dispatchId}\`${q.taskId ? `, task \`${q.taskId}\`` : ""}). It asked:

${clip(q.question)}${options}

Answer it now, from what this thread already knows: \`orca orchestration reply --id ${q.id} --run ${q.runId} --body "<answer>"\` (ORCA_TERMINAL_HANDLE is already set, so no --from; for a long answer pass --body "$(cat <<'EOF' ... EOF)"). That reply is the only way the worker hears you, and it waits until you send one. Do not ask the thread and wait for an answer - nobody may come. If the thread does not settle it, pick the safe option, reply with that, and say so. Then tell the thread in one short line what the worker asked and what you answered.`;
};
