/**
 * `runTurn`: a turn started from outside the Slack handler (a watch, a loop
 * fire, `tell`, the stale-promise sweep, an Orca question, `mindful`). It goes
 * through the ordinary respond path - same queue, same session, same role
 * checks - and posts what comes back, signed with the cost and with what
 * started it (`trigger`, named by the sender; never guessed from the text).
 */
import type { InternalKind } from "../domain/internalMessages.ts";
import { isSilenceNote } from "../domain/silence.ts";
import { syntheticTs } from "../domain/slackLinks.ts";
import type { HandleResult, InboundMessage } from "./handleMessage.ts";
import { loopReplyOf } from "./loops.ts";
import type { SlackAdminPort } from "./slackAdmin.ts";

export type TurnRequest = {
  channelId: string;
  threadTs: string;
  slackUserId: string;
  text: string;
  keepSession?: boolean;
  autoContinue?: boolean;
  unprompted?: boolean;
  workerLane?: boolean;
  loop?: boolean;
  hold?: boolean;
  /** What the bot's own sender is, for the reply's footer. */
  trigger?: InternalKind;
};

export const createTurnRunner =
  (d: {
    respond: (inbound: InboundMessage) => Promise<HandleResult>;
    post: SlackAdminPort["post"];
    clock: () => number;
    /** The model a loop's fire runs on. */
    loopModel: () => string | undefined;
  }) =>
  async ({ channelId, threadTs, slackUserId, text, keepSession, autoContinue, unprompted, workerLane, loop, hold, trigger }: TurnRequest) => {
    const result = await d.respond({
      channelId,
      slackUserId,
      text,
      threadTs,
      messageTs: syntheticTs(d.clock()),
      viaSlash: false,
      following: false,
      keepSession,
      autoContinue,
      unprompted,
      workerLane,
      trigger,
      // A loop's fire runs on Sonnet; replies a person types in its DM thread are ordinary turns.
      model: loop ? d.loopModel() : undefined,
    });
    // A turn nobody watched live can still answer with a note about not
    // answering; posted, it reads as the whole reply.
    // A loop's fire: the runner posts it (with its header and its own
    // `triggered by loop`) or not at all.
    if (hold) return result.kind === "ignored" ? undefined : loopReplyOf(result.text);
    if (result.kind !== "ignored" && result.text.trim() && !isSilenceNote(result.text)) {
      // Signed with what the turn cost, as a reply streamed live would be.
      await d.post(
        channelId,
        result.text,
        threadTs,
        result.kind === "reply" ? result.by : undefined,
        result.kind === "reply" ? result.usage : undefined,
        result.kind === "reply" ? result.trigger : undefined,
      );
    }
  };
