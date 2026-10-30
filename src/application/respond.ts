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
import { busyNotice, nameOfRequest } from "../domain/runControl.ts";
import { sessionThreadKey } from "../domain/agentSession.ts";
import { DROP_ACTION, STOP_ACTION, type RunRegistry } from "./runRegistry.ts";
import type { ThreadQueue } from "./threadQueue.ts";
import type { UserRole } from "../domain/types.ts";
import type { PostedRef } from "./slackAdmin.ts";
import { handleMessage, type HandleMessageDeps, type HandleResult, type InboundMessage } from "./handleMessage.ts";
import type { LlmStreamSink } from "./ports.ts";

export type RespondDeps = HandleMessageDeps & {
  /**
   * Serialises the turns of one thread. Without it two messages sent a few
   * minutes apart run at once, doing the same work twice and resuming the same
   * CLI session from two processes.
   */
  threadQueue?: ThreadQueue;
  /** In-flight turns, so one can be stopped from a button or a command. */
  runs?: RunRegistry;
};

const RANK: Record<UserRole, number> = { pal: 0, executer: 1, admin: 2, owner: 3 };

/**
 * Tell a thread it is busy, with the two ways out on the message.
 *
 * Falls back to plain text when there are no buttons to be had (no Slack wired
 * up, or interactivity off), because the sentence is the part that matters.
 */
const announceBusy = async (
  deps: RespondDeps,
  inbound: InboundMessage,
  key: string,
  queuedId?: string,
): Promise<void> => {
  const running = deps.runs?.current(key);
  const text = running
    ? busyNotice(running, deps.clock())
    : "⏳ still on the one before this, I will pick it up next";
  const actions = [
    ...(running
      ? [{ actionId: STOP_ACTION, label: "Stop that one", value: running.id, style: "danger" as const }]
      : []),
    ...(queuedId ? [{ actionId: DROP_ACTION, label: "Never mind", value: queuedId }] : []),
  ];
  try {
    if (actions.length > 0 && deps.slack?.postInteractive) {
      const posted = await deps.slack.postInteractive(inbound.channelId, text, actions, inbound.threadTs);
      if (posted) return;
    }
    await deps.slack?.post(inbound.channelId, text, inbound.threadTs);
  } catch {
    // A notice that cannot be posted must not take the turn down with it.
  }
};

export const respond = async (
  deps: RespondDeps,
  inbound: InboundMessage,
  sink?: LlmStreamSink,
): Promise<HandleResult> => {
  const line = commandLineOf(inbound.text, deps.commandPrefix);
  if (line === undefined) {
    // "@bot review <pr url>" is the command, not a conversation about it. Said
    // in words it used to reach the chat brain, which would describe a review
    // rather than run one - and describe the token rather than offer the box
    // that takes it. Same words, same path, whichever way it was typed.
    // `!` is the legacy trigger and needs no configured prefix, so this works
    // the same whether or not the instance set one.
    const asked = reviewRequestIn(inbound.text);
    if (asked) return respond(deps, { ...inbound, text: `!${asked}` }, sink);

    // One function, shared with the agent-session stop handler: if the two ever
    // built this string differently, Slack's stop button would silently find
    // nothing to stop and only the spinner would tell anyone.
    const key = sessionThreadKey(inbound.channelId, inbound.threadTs ?? inbound.messageTs ?? "");
    const what = nameOfRequest(inbound.text);
    // Track the turn so it can be stopped: a chat turn may run for the better
    // part of an hour, and waiting one out is not a way to correct course.
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const tracked = deps.runs?.track({
      id: runId,
      key,
      channelId: inbound.channelId,
      threadTs: inbound.threadTs,
      actor: inbound.slackUserId,
      what,
      startedAt: deps.clock(),
    });

    const chatTurn = async (): Promise<HandleResult> => {
      // Called off while it waited its turn, so it never spawns anything.
      if (tracked?.signal.aborted) return { kind: "ignored" };
      tracked?.running();
      try {
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
            return {
              kind: "reply",
              text: await runWorkflowTurn(deps, workflow, who.user, text, false, sink, tracked?.signal),
            };
          }
        }
        return await handleMessage(deps, inbound, sink, tracked?.signal);
      } catch (err) {
        // A stopped run is killed exactly as the timeout kills one, so without
        // this it would be reported as a turn that ran out of time. The thread
        // has already been told it was stopped, by whoever stopped it.
        if (tracked?.signal.aborted) return { kind: "ignored" };
        throw err;
      } finally {
        tracked?.done();
      }
    };

    // Chat and workflow turns share the thread's one session, so they take it
    // in turns. Commands are left free: a review is its own process, and
    // queueing one behind a long chat turn would make it look dead.
    const queue = deps.threadQueue;
    if (!queue) return chatTurn();
    if (queue.depth(key) > 0) {
      // Say so rather than going quiet, and offer the two things a person who
      // just sent a follow-up actually wants: end the one in the way, or take
      // this one back. Doing nothing still queues it, which is the old
      // behaviour and the right default.
      // Not when following: nobody asked, so nobody is waiting on a place in
      // the queue, and "yours is next" in a channel is noise about the bot's
      // own scheduling rather than anything the thread needs.
      if (!inbound.following) await announceBusy(deps, inbound, key, tracked ? runId : undefined);
    }
    return queue.run(key, chatTurn);
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
