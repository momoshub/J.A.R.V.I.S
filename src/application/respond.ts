/**
 * Top-level responder that Slack (or any transport) calls with one inbound
 * message. It routes command lines (the configured prefix, or legacy `!`) to the
 * command registry and everything else to the chat use case, so the transport
 * adapter stays dumb.
 */
import type { ReviewGuard } from "./reviewGuard.ts";
import { decideAccess } from "../domain/access.ts";
import { disabledRoleReason } from "../domain/rolePolicy.ts";
import { cleanInboundText } from "../domain/conversation.ts";
import { commandLineOf, dispatchCommand, notifiesOwner } from "./commands.ts";
import { runFrontTurn, runWorkflowTurn, WORKFLOW_MIN_ROLE } from "./workflow.ts";
import { afterFailedStep, afterWorkflowTurn, steerWorker } from "./workflowContinue.ts";
import { frontDigest, type FrontDeps } from "./workflowFront.ts";
import { frontKeyOf, steeredMessage } from "../domain/workflowFront.ts";
import { SIGNATURES } from "../domain/messageFooter.ts";
import { requestAccess } from "./accessRequests.ts";
import { reviewRequestIn } from "../domain/reviewRequest.ts";
import { busyNotice, nameOfRequest } from "../domain/runControl.ts";
import { sessionThreadKey } from "../domain/agentSession.ts";
import { isRestartCut, type RunRegistry } from "./runRegistry.ts";
import type { ThreadQueue } from "./threadQueue.ts";
import type { UserRole } from "../domain/types.ts";
import type { PostedRef } from "./slackAdmin.ts";
import type { TurnOutcome } from "../infrastructure/db/turnLogRepo.ts";
import { handleMessage, type HandleMessageDeps, type HandleResult, type InboundMessage } from "./handleMessage.ts";
import type { BackgroundAgentsPort, LlmStreamSink } from "./ports.ts";

export type RespondDeps = HandleMessageDeps & Pick<FrontDeps, "workerCalls"> & {
  /**
   * Serialises the turns of one thread. Without it two messages sent a few
   * minutes apart run at once, doing the same work twice and resuming the same
   * CLI session from two processes.
   */
  threadQueue?: ThreadQueue;
  /** In-flight turns, so one can be stopped from a button or a command. */
  runs?: RunRegistry;
  /** Background agents a thread's turns left running, so `stop` ends them too. */
  backgroundAgents?: BackgroundAgentsPort;
  /** One review per PR at a time, across the review inbox and `review`. */
  reviewGuard?: ReviewGuard;
  /** True while a restart waits for running turns; pending workflow steps hold. */
  draining?: () => boolean;
  /** Failed workflow steps in a row, per workflow id, so a failure is retried once. */
  stepFailures?: Map<number, number>;
};

const RANK: Record<UserRole, number> = { pal: 0, executer: 1, admin: 2, owner: 3 };

/**
 * Tell a thread it is busy.
 *
 * It used to carry its own Stop and Never-mind buttons. Slack now draws a
 * native stop control on any session the bot is streaming into
 * (`agent_session_stopped`), so a second pair of buttons beside it was two
 * mechanisms for one job - and the home-made one was the weaker, since it only
 * existed on this notice and only while somebody was queued behind a turn.
 * The sentence was always the part that mattered.
 *
 * It names the running turn by a link to the message that asked for it, and
 * returns where it landed: the notice is only true while the turn waits, so
 * the queued turn takes it down when it starts.
 */
const announceBusy = async (
  deps: RespondDeps,
  inbound: InboundMessage,
  key: string,
): Promise<PostedRef | undefined> => {
  const running = deps.runs?.current(key);
  try {
    const link =
      running?.messageTs && deps.slack?.permalink
        ? await deps.slack.permalink(running.channelId, running.messageTs)
        : undefined;
    const text = running
      ? busyNotice(running, deps.clock(), link)
      : "⏳ still on the one before this, I will pick it up next";
    return (await deps.slack?.post(inbound.channelId, text, inbound.threadTs)) || undefined;
  } catch {
    // A notice that cannot be posted must not take the turn down with it.
    return undefined;
  }
};

/** Take a busy notice down. Best-effort: a stale notice is not worth a failed turn. */
const clearBusy = async (deps: RespondDeps, notice: PostedRef | undefined): Promise<void> => {
  if (!notice) return;
  try {
    await deps.slack?.remove(notice.channel, notice.ts);
  } catch {
    // already gone, or not ours to delete
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
    const threadKey = sessionThreadKey(inbound.channelId, inbound.threadTs ?? inbound.messageTs ?? "");
    // A workflow thread has two lanes. Its worker's steps run on the thread's
    // own key, as they always did, so the stop button and `stop` still reach
    // them. A person's message runs on the front's key, so it is answered
    // while a step is running instead of waiting behind it.
    const inWorkflow =
      !inbound.autoContinue && inbound.threadTs
        ? deps.workflows?.activeFor(inbound.channelId, inbound.threadTs) !== undefined
        : false;
    const key = inWorkflow ? frontKeyOf(threadKey) : threadKey;
    const what = nameOfRequest(inbound.text);
    // Track the turn so it can be stopped: a chat turn may run for the better
    // part of an hour, and waiting one out is not a way to correct course.
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // A thread driving a workflow is a worker carrying on by itself. Looked up
    // here rather than inside the turn because the restart needs to know
    // before the turn starts whether this one should hold it open.
    const workflowThread =
      inbound.threadTs !== undefined && deps.workflows?.activeFor(inbound.channelId, inbound.threadTs) !== undefined;
    const tracked = deps.runs?.track({
      id: runId,
      key,
      channelId: inbound.channelId,
      threadTs: inbound.threadTs,
      actor: inbound.slackUserId,
      what,
      messageTs: inbound.messageTs,
      startedAt: deps.clock(),
      ...(workflowThread ? { background: true } : {}),
      ...(inbound.inboxRowId !== undefined ? { inboxRowId: inbound.inboxRowId } : {}),
    });
    // The "still working on ..." notice this message got, if it had to wait.
    let busy: PostedRef | undefined;

    const chatTurn = async (): Promise<HandleResult> => {
      // Its turn has come (or it was called off), so "yours is next" is no
      // longer true. The answer lands as a new message; the notice goes.
      await clearBusy(deps, busy);
      // Called off while it waited its turn, so it never spawns anything.
      if (tracked?.signal.aborted) return { kind: "ignored" };
      tracked?.running();
      const startedAt = deps.clock();
      // How this ended, recorded whichever way it ends. Nothing used to write
      // this down: a failed chat turn left a line on stderr and an apology in
      // a thread, so "what broke this afternoon, and where" had no answer.
      const record = (outcome: TurnOutcome, error = ""): void => {
        deps.turns?.add({
          runId,
          channelId: inbound.channelId,
          threadTs: inbound.threadTs ?? inbound.messageTs ?? "",
          slackUserId: inbound.slackUserId,
          kind: "chat",
          request: cleanInboundText(inbound.text),
          outcome,
          error,
          startedAt,
          endedAt: deps.clock(),
        });
      };
      // Cut at its budget while a restart waits. A streamed turn that had
      // already said something returns its fragment rather than throwing, so
      // this is checked after the call as well as in the catch: the fragment
      // is not the answer, and the next process picks the message up again.
      const restartCut = (): HandleResult => {
        record("stopped", "cut for a restart, picked up again after it");
        return { kind: "ignored" };
      };
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
            if (inbound.autoContinue) {
              // The worker's step. What people said meanwhile rides along with
              // it, and is only cleared once the step has run.
              const steers = workflow.steers;
              const text = steeredMessage(
                cleanInboundText(inbound.text),
                steers,
                (id) => deps.users.get(id)?.displayName,
              );
              const turn = await runWorkflowTurn(deps, workflow, who.user, text, false, sink, tracked?.signal);
              if (isRestartCut(tracked?.signal)) return restartCut();
              if (steers.length > 0) deps.workflows?.dropSteers(workflow.id, steers.length);
              record("ok");
              // Stopped part way: whatever it said, nobody wants the next step.
              if (!tracked?.signal.aborted) {
                await afterWorkflowTurn(deps, workflow, who.user.slackId, turn.wantsContinue, deps.commandPrefix);
              }
              return { kind: "reply", text: turn.text, by: SIGNATURES.workflowWorker };
            }
            if (key !== threadKey) {
              // The front: answer now, from a digest of where the worker is,
              // and pass on anything meant for the work.
              const digest = frontDigest(deps, workflow, threadKey);
              const text = cleanInboundText(inbound.text);
              const turn = await runFrontTurn(deps, workflow, who.user, text, digest, sink, tracked?.signal);
              if (isRestartCut(tracked?.signal)) return restartCut();
              record("ok");
              if (turn.steers.length > 0 && !tracked?.signal.aborted) {
                steerWorker(deps, workflow, who.user.slackId, turn.steers, threadKey);
              }
              return { kind: "reply", text: turn.text, by: SIGNATURES.workflowFront };
            }
          }
        }
        // A step the bot queued for a workflow that has since ended, or for
        // someone who may no longer steer it, is not a chat message.
        if (inbound.autoContinue) return { kind: "ignored" };
        const result = await handleMessage(deps, inbound, sink, tracked?.signal);
        if (isRestartCut(tracked?.signal)) return restartCut();
        // "ignored" is not a turn that happened - it was not for us, or it was
        // dropped before it began - so there is nothing to record about it.
        if (result.kind !== "ignored") record("ok");
        return result;
      } catch (err) {
        // A stopped run is killed exactly as the timeout kills one, so without
        // this it would be reported as a turn that ran out of time. The thread
        // has already been told it was stopped, by whoever stopped it.
        if (tracked?.signal.aborted) {
          record("stopped", "stopped before it finished");
          return { kind: "ignored" };
        }
        const message = err instanceof Error ? err.message : String(err);
        record("failed", message);
        // A worker step has nobody waiting on its error: say so in the thread
        // and retry, or the notes queued for it are never delivered.
        const failedWorkflow =
          inbound.autoContinue && inbound.threadTs
            ? deps.workflows?.activeFor(inbound.channelId, inbound.threadTs)
            : undefined;
        if (failedWorkflow) {
          await afterFailedStep(deps, failedWorkflow, inbound.slackUserId, message, deps.commandPrefix);
          return { kind: "ignored" };
        }
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
      // Nor for a workflow's own next step or a watch handing the thread back:
      // nobody typed either, so "yours is next" would be addressed to no one.
      if (inbound.autoContinue || inbound.unprompted) busy = undefined;
      else if (!inbound.following) busy = await announceBusy(deps, inbound, key);
    }
    return queue.run(key, chatTurn);
  }

  const decision = decideAccess(inbound.slackUserId, deps.ownerSlackId, deps.users.get);
  if (!decision.allowed) {
    const off = deps.roleDisabled?.(inbound.slackUserId);
    if (off) return { kind: "denied", text: disabledRoleReason(off) };
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
      ? (text: string) => deps.slack!.postDm(inbound.slackUserId, text, SIGNATURES.command)
      : (text: string) => deps.slack!.post(inbound.channelId, text, inbound.threadTs, SIGNATURES.command)
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
          SIGNATURES.command,
        );
        if (!root) return; // could not open the DM, so there is no thread to fill
      }
      await deps.slack!.post(root.channel, text, root.ts, SIGNATURES.command);
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
  return { kind: "reply", text, by: SIGNATURES.command };
};
