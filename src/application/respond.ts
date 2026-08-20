/**
 * Top-level responder that Slack (or any transport) calls with one inbound
 * message. It routes `!commands` to the command layer and everything else to the
 * chat use case, so the transport adapter stays dumb.
 */
import { decideAccess } from "../domain/access.ts";
import { executeCommand, parseCommand } from "./commands.ts";
import { handleMessage, type HandleMessageDeps, type HandleResult, type InboundMessage } from "./handleMessage.ts";
import type { LlmStreamSink } from "./ports.ts";

export type RespondDeps = HandleMessageDeps;

export const respond = async (
  deps: RespondDeps,
  inbound: InboundMessage,
  sink?: LlmStreamSink,
): Promise<HandleResult> => {
  const command = parseCommand(inbound.text);
  if (!command) return handleMessage(deps, inbound, sink);

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
  const text = executeCommand(
    { users: deps.users, messages: deps.messages, clock: deps.clock, ownerSlackId: deps.ownerSlackId },
    actor,
    command,
    inbound.channelId,
  );
  return { kind: "reply", text };
};
