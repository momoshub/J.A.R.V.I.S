/**
 * Top-level responder that Slack (or any transport) calls with one inbound
 * message. It routes command lines (the configured prefix, or legacy `!`) to the
 * command registry and everything else to the chat use case, so the transport
 * adapter stays dumb.
 */
import { decideAccess } from "../domain/access.ts";
import { cleanInboundText } from "../domain/conversation.ts";
import { commandLineOf, dispatchCommand } from "./commands.ts";
import { runWorkflowTurn, WORKFLOW_MIN_ROLE } from "./workflow.ts";
import type { UserRole } from "../domain/types.ts";
import { handleMessage, type HandleMessageDeps, type HandleResult, type InboundMessage } from "./handleMessage.ts";
import type { LlmStreamSink } from "./ports.ts";

export type RespondDeps = HandleMessageDeps;

const RANK: Record<UserRole, number> = { pal: 0, executer: 1, admin: 2, owner: 3 };

export const respond = async (
  deps: RespondDeps,
  inbound: InboundMessage,
  sink?: LlmStreamSink,
): Promise<HandleResult> => {
  const line = commandLineOf(inbound.text, deps.commandPrefix);
  if (line === undefined) {
    // A thread driving a workflow keeps talking to that session, not to the
    // ordinary chat brain - the session is the one holding the task.
    const workflow = inbound.threadTs
      ? deps.workflows?.activeFor(inbound.channelId, inbound.threadTs)
      : undefined;
    if (workflow) {
      const who = decideAccess(inbound.slackUserId, deps.ownerSlackId, deps.users.get);
      // Anyone below the workflow role can still chat in the thread; they just
      // do not get to steer the task.
      if (who.allowed && RANK[who.user.role] >= RANK[WORKFLOW_MIN_ROLE]) {
        const text = cleanInboundText(inbound.text);
        return { kind: "reply", text: await runWorkflowTurn(deps, workflow, who.user, text, false, sink) };
      }
    }
    return handleMessage(deps, inbound, sink);
  }

  const decision = decideAccess(inbound.slackUserId, deps.ownerSlackId, deps.users.get);
  if (!decision.allowed) return { kind: "denied", text: decision.reason };

  // Make sure the actor exists so role checks resolve (owner auto-provisions).
  if (!deps.users.get(decision.user.slackId)) {
    deps.users.upsert({
      slackId: decision.user.slackId,
      role: decision.user.role,
      displayName: inbound.displayName ?? "",
      addedBy: "system",
      createdAt: deps.clock(),
    });
  }

  const actor = deps.users.get(decision.user.slackId) ?? decision.user;

  // Destination for progress + direct results: a DM when invoked via slash (there
  // is no thread to reply in), otherwise the thread the message came from. Long
  // commands (review) post through this; simple ones just return their text.
  const reply = deps.slack
    ? inbound.viaSlash
      ? (text: string) => deps.slack!.postDm(inbound.slackUserId, text)
      : (text: string) => deps.slack!.post(inbound.channelId, text, inbound.threadTs)
    : undefined;

  const text = await dispatchCommand(deps, actor, inbound.channelId, line, {
    prefix: deps.commandPrefix,
    slash: deps.slashCommand,
    // A slash command has no thread to bind a workflow to.
    threadTs: inbound.viaSlash ? undefined : inbound.threadTs,
    reply,
  });
  return { kind: "reply", text };
};
