/**
 * Top-level responder that Slack (or any transport) calls with one inbound
 * message. It routes command lines (the configured prefix, or legacy `!`) to the
 * command registry and everything else to the chat use case, so the transport
 * adapter stays dumb.
 */
import { decideAccess } from "../domain/access.ts";
import { commandLineOf, dispatchCommand } from "./commands.ts";
import { handleMessage, type HandleMessageDeps, type HandleResult, type InboundMessage } from "./handleMessage.ts";
import type { LlmStreamSink } from "./ports.ts";

export type RespondDeps = HandleMessageDeps;

export const respond = async (
  deps: RespondDeps,
  inbound: InboundMessage,
  sink?: LlmStreamSink,
): Promise<HandleResult> => {
  const line = commandLineOf(inbound.text, deps.commandPrefix);
  if (line === undefined) return handleMessage(deps, inbound, sink);

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
    reply,
  });
  return { kind: "reply", text };
};
