/**
 * Workflow use case - a long task driven from one Slack thread.
 *
 * Unlike a chat reply, which replays a transcript into a fresh CLI process each
 * time, a workflow claims a CLI session id up front and resumes it on every
 * turn. The model keeps its own context and its files, so the thread becomes a
 * back-and-forth with something that is genuinely still working on the task.
 *
 * The session id lives in the database, so a bot restart does not lose it.
 */
import { frontPrompt, workflowPrompt } from "../domain/workflowPrompt.ts";
import { createMarkerFilter, parseContinue } from "../domain/workflowContinue.ts";
import { createSteerFilter, FRONT_TIMEOUT_MS, frontMessage, parseSteers } from "../domain/workflowFront.ts";
import { PAL_TOOLS } from "../domain/toolPolicy.ts";
import { tokenFor, type ClaudeTokenPort } from "./claudeTokens.ts";
import type { AllowedUser, UserRole, Workflow } from "../domain/types.ts";
import type { ToolPolicy } from "../domain/toolPolicy.ts";
import type { Clock, LlmPort, LlmStreamSink, LlmUsage } from "./ports.ts";
import type { WorkflowRepo } from "../infrastructure/db/workflowRepo.ts";

/** A workflow turn can run long - it is a real task, not a chat reply. */
export const WORKFLOW_TIMEOUT_MS = 900_000;

/** Billing kind of a worker step - also how its tool calls are found in the trace. */
export const WORKER_BILL_KIND = "workflow";

/** Lowest role that may drive a workflow (executer, admin, owner). */
export const WORKFLOW_MIN_ROLE: UserRole = "executer";

export type WorkflowDeps = {
  workflows?: WorkflowRepo;
  llm?: LlmPort;
  clock: Clock;
  toolPolicy?: (role: UserRole, channelId?: string) => ToolPolicy;
  botInfo?: () => { botName: string; model: string };
  /** Fresh session id; injected so tests are deterministic. */
  newSessionId?: () => string;
  /** Per-user Claude Code tokens: the session runs on its driver's credential. */
  claudeTokens?: ClaudeTokenPort;
};

const botNameOf = (deps: WorkflowDeps): string => deps.botInfo?.().botName ?? "Assistant";

/** What one workflow turn said, and whether it asked to carry on by itself. */
export type WorkflowTurn = {
  readonly text: string;
  readonly wantsContinue: boolean;
  /** What the step cost, when the model reported it - for the reply's footer. */
  readonly usage?: LlmUsage;
};

/**
 * The live stream minus the `[continue]` marker, so it never flashes up in
 * the thread. A held-back fragment is released before anything that is not
 * text, so ordering is kept.
 */
const filteredSink = (
  sink: LlmStreamSink,
  filter: { push: (delta: string) => string; flush: () => string } = createMarkerFilter(),
): LlmStreamSink => {
  return (event) => {
    if (event.type === "text") {
      const delta = filter.push(event.delta);
      if (delta) sink({ type: "text", delta });
      return;
    }
    const held = filter.flush();
    if (held) sink({ type: "text", delta: held });
    sink(event);
  };
};

/**
 * Run one turn against the workflow's session. `first` claims the session id,
 * every later turn resumes it.
 */
export const runWorkflowTurn = async (
  deps: WorkflowDeps,
  workflow: Workflow,
  actor: AllowedUser,
  message: string,
  first: boolean,
  sink?: LlmStreamSink,
  /** Ends the turn when aborted, so a long one can be stopped. */
  signal?: AbortSignal,
): Promise<WorkflowTurn> => {
  if (!deps.llm) return { text: "My brain is not wired up right now.", wantsContinue: false };
  const name = botNameOf(deps);
  const base = deps.toolPolicy?.(actor.role, workflow.channelId) ?? { skipPermissions: true };
  let usage: LlmUsage | undefined;
  const params = {
    system: workflowPrompt(name, workflow.task),
    // Only the new message: the session is holding the rest of the conversation.
    messages: [{ role: "user" as const, content: message, speakerId: actor.slackId }],
    assistantName: name,
    policy: { ...base, timeoutMs: WORKFLOW_TIMEOUT_MS },
    session: { id: workflow.sessionId, resume: !first },
    oauthToken: tokenFor(deps, actor),
    signal,
    bill: { actor: actor.slackId, kind: WORKER_BILL_KIND, channel: workflow.channelId, threadTs: workflow.threadTs },
    onUsage: (u: LlmUsage) => {
      usage = u;
    },
  };

  const raw =
    sink && deps.llm.stream ? await deps.llm.stream(params, filteredSink(sink)) : await deps.llm.complete(params);
  const { text, wantsContinue } = parseContinue(raw);

  deps.workflows?.recordTurn(workflow.id, deps.clock());
  // The front reads these to say where the work is.
  if (text) deps.workflows?.recordWorkerReply(workflow.id, text, deps.clock());
  // A step that only said "carry on" has nothing for the thread to read.
  return {
    text: text || (wantsContinue ? "" : "(nothing came back from that turn)"),
    wantsContinue,
    ...(usage ? { usage } : {}),
  };
};

/** Billing kind of a front turn - also what keeps it out of the worker's digest. */
export const FRONT_BILL_KIND = "workflow-front";

/** What one front turn said, and what it passed on to the worker. */
export type FrontTurn = {
  readonly text: string;
  readonly steers: readonly string[];
  /** What the turn cost, when the model reported it - for the reply's footer. */
  readonly usage?: LlmUsage;
};

/**
 * Answer a person in a workflow thread from the front session, given a digest
 * of where the worker is. Read-only tools and a short timeout: it is there to
 * talk, the worker does the task. Its session id is claimed on the first turn
 * that finishes, so a first turn that dies leaves nothing to resume.
 */
export const runFrontTurn = async (
  deps: WorkflowDeps,
  workflow: Workflow,
  actor: AllowedUser,
  message: string,
  digest: string,
  sink?: LlmStreamSink,
  signal?: AbortSignal,
): Promise<FrontTurn> => {
  if (!deps.llm) return { text: "My brain is not wired up right now.", steers: [] };
  const name = botNameOf(deps);
  const base = deps.toolPolicy?.(actor.role, workflow.channelId) ?? { skipPermissions: true };
  const sessionId = workflow.frontSessionId ?? (deps.newSessionId ?? (() => crypto.randomUUID()))();
  let usage: LlmUsage | undefined;
  const params = {
    system: frontPrompt(name, workflow.task),
    messages: [{ role: "user" as const, content: frontMessage(digest, message), speakerId: actor.slackId }],
    assistantName: name,
    // Read-only, whatever the role: the worker is the one with its hands on things.
    policy: { ...base, skipPermissions: false, allowedTools: PAL_TOOLS, timeoutMs: FRONT_TIMEOUT_MS },
    session: { id: sessionId, resume: workflow.frontSessionId !== undefined },
    oauthToken: tokenFor(deps, actor),
    signal,
    bill: { actor: actor.slackId, kind: FRONT_BILL_KIND, channel: workflow.channelId, threadTs: workflow.threadTs },
    onUsage: (u: LlmUsage) => {
      usage = u;
    },
  };
  const raw =
    sink && deps.llm.stream
      ? await deps.llm.stream(params, filteredSink(sink, createSteerFilter()))
      : await deps.llm.complete(params);
  if (workflow.frontSessionId === undefined) deps.workflows?.setFrontSession(workflow.id, sessionId);
  const { text, steers } = parseSteers(raw);
  return { text: text || (steers.length > 0 ? "Passed that on." : "(nothing came back)"), steers, ...(usage ? { usage } : {}) };
};
