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
import { workflowPrompt } from "../domain/workflowPrompt.ts";
import { createMarkerFilter, parseContinue } from "../domain/workflowContinue.ts";
import { tokenFor, type ClaudeTokenPort } from "./claudeTokens.ts";
import type { AllowedUser, UserRole, Workflow } from "../domain/types.ts";
import type { ToolPolicy } from "../domain/toolPolicy.ts";
import type { Clock, LlmPort, LlmStreamSink } from "./ports.ts";
import type { WorkflowRepo } from "../infrastructure/db/workflowRepo.ts";

/** A workflow turn can run long - it is a real task, not a chat reply. */
export const WORKFLOW_TIMEOUT_MS = 900_000;

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
};

/**
 * The live stream minus the `[continue]` marker, so it never flashes up in
 * the thread. A held-back fragment is released before anything that is not
 * text, so ordering is kept.
 */
const filteredSink = (sink: LlmStreamSink): LlmStreamSink => {
  const filter = createMarkerFilter();
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
  const params = {
    system: workflowPrompt(name, workflow.task),
    // Only the new message: the session is holding the rest of the conversation.
    messages: [{ role: "user" as const, content: message, speakerId: actor.slackId }],
    assistantName: name,
    policy: { ...base, timeoutMs: WORKFLOW_TIMEOUT_MS },
    session: { id: workflow.sessionId, resume: !first },
    oauthToken: tokenFor(deps, actor),
    signal,
    bill: { actor: actor.slackId, kind: "workflow", channel: workflow.channelId, threadTs: workflow.threadTs },
  };

  const raw =
    sink && deps.llm.stream ? await deps.llm.stream(params, filteredSink(sink)) : await deps.llm.complete(params);
  const { text, wantsContinue } = parseContinue(raw);

  deps.workflows?.recordTurn(workflow.id, deps.clock());
  // A step that only said "carry on" has nothing for the thread to read.
  return { text: text || (wantsContinue ? "" : "(nothing came back from that turn)"), wantsContinue };
};
