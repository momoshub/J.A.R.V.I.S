/**
 * Top-level responder that Slack (or any transport) calls with one inbound
 * message. It routes command lines (the configured prefix, or legacy `!`) to the
 * command registry and everything else to the chat use case, so the transport
 * adapter stays dumb.
 */
import { decideAccess } from "../domain/access.ts";
import { cleanInboundText } from "../domain/conversation.ts";
import { commandLineOf, dispatchCommand, notifiesOwner } from "./commands.ts";
import { runWorkflowTurn, WORKFLOW_MIN_ROLE } from "./workflow.ts";
import { requestAccess } from "./accessRequests.ts";
import { reviewRequestIn } from "../domain/reviewRequest.ts";
import type { UserRole } from "../domain/types.ts";
import type { PostedRef } from "./slackAdmin.ts";
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
    // "@bot review <pr url>" is the command, not a conversation about it. Said
    // in words it used to reach the chat brain, which would describe a review
    // rather than run one - and describe the token rather than offer the box
    // that takes it. Same words, same path, whichever way it was typed.
    const asked = reviewRequestIn(inbound.text);
    // `!` is the legacy trigger and needs no configured prefix, so this works
    // the same whether or not the instance set one.
    if (asked) return respond(deps, { ...inbound, text: `!${asked}` }, sink);
    return handleMessage(deps, inbound, sink);
  }

  const decision = decideAccess(inbound.slackUserId, deps.ownerSlackId, deps.users.get);
  if (!decision.allowed) {
    const text = await requestAccess(
      deps,
      {
        slackUserId: inbound.slackUserId,
        displayName: inbound.displayName,
        channelId: inbound.channelId,
        threadTs: inbound.threadTs,
        text: inbound.text,
      },
      decision.reason,
    );
    return text === undefined ? { kind: "ignored" } : { kind: "denied", text };
  }

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
  const deliver = deps.slack
    ? inbound.viaSlash
      ? (text: string) => deps.slack!.postDm(inbound.slackUserId, text)
      : (text: string) => deps.slack!.post(inbound.channelId, text, inbound.threadTs)
    : undefined;

  // A slash command is invisible to everyone but its caller, so the owner gets
  // their own copy of anything that actually did something. One invocation is
  // one DM thread: a header saying who ran what, and everything else hanging
  // off it, so a busy day is a list of runs rather than a wall of fragments.
  const mirror =
    deps.slack && inbound.viaSlash && actor.slackId !== deps.ownerSlackId && notifiesOwner(line);
  let root: PostedRef | undefined;
  let opening = false;
  const toOwner = async (text: string): Promise<void> => {
    if (!mirror) return;
    try {
      if (!root) {
        // Guard the header against a second caller slipping in while it posts.
        if (opening) return;
        opening = true;
        root = await deps.slack!.postDm(
          deps.ownerSlackId,
          `📋 <@${actor.slackId}> ran \`${deps.slashCommand ?? "/bot"} ${line}\``,
        );
        if (!root) return; // could not open the DM, so there is no thread to fill
      }
      await deps.slack!.post(root.channel, text, root.ts);
    } catch {
      // the owner's copy is never worth failing the caller's command over
    }
  };

  const reply = deliver
    ? async (text: string) => {
        await deliver(text);
        await toOwner(text);
      }
    : mirror
      ? toOwner
      : undefined;

  const text = await dispatchCommand(deps, actor, inbound.channelId, line, {
    prefix: deps.commandPrefix,
    slash: deps.slashCommand,
    // A slash command has no thread to bind a workflow to.
    threadTs: inbound.viaSlash ? undefined : inbound.threadTs,
    reply,
  });
  // Commands that returned their result rather than posting it still get copied.
  if (text.trim()) await toOwner(text);
  return { kind: "reply", text };
};
