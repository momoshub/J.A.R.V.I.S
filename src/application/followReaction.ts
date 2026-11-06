/**
 * The owner switching following off in a thread with a reaction.
 *
 * 🪨 `rock` on a message in the thread that is the bot's own or tags it, and
 * the bot stops reading that thread untagged - and remembers it, so a later
 * one-on-one line does not turn it back on. Silent: nothing is posted, the
 * reaction is the whole conversation.
 *
 * Only the owner, and only on the bot's messages or ones addressed to it, so
 * a rock on anything else is just a rock.
 */
import { isFollowOffReaction, mentionsBot } from "../domain/threadFollow.ts";
import type { FollowRepo } from "../infrastructure/db/followRepo.ts";
import type { SlackAdminPort } from "./slackAdmin.ts";

export type FollowReactionDeps = {
  slack?: SlackAdminPort;
  follows?: FollowRepo;
  ownerSlackId: string;
  clock: () => number;
};

export type FollowReactionEvent = { slackUserId: string; reaction: string; channel: string; ts: string };

export type FollowReactionOutcome =
  | { kind: "unfollowed"; threadTs: string }
  | { kind: "ignored"; why: string };

export const unfollowOnReaction = async (
  deps: FollowReactionDeps,
  event: FollowReactionEvent,
): Promise<FollowReactionOutcome> => {
  if (!isFollowOffReaction(event.reaction)) return { kind: "ignored", why: "not the follow-off reaction" };
  if (event.slackUserId !== deps.ownerSlackId) return { kind: "ignored", why: "not the owner" };
  if (!deps.follows) return { kind: "ignored", why: "no follow store" };
  const slack = deps.slack;
  if (!slack?.lookup) return { kind: "ignored", why: "no slack" };

  const [me, msg] = await Promise.all([slack.botUserId(), slack.lookup(event.channel, event.ts)]);
  if (!msg) return { kind: "ignored", why: "message not found" };
  if (!me) return { kind: "ignored", why: "bot id unknown" };
  if (msg.userId !== me && !mentionsBot(msg.text, me)) return { kind: "ignored", why: "not mine or for me" };

  // A top-level message is its own thread's parent.
  const threadTs = msg.threadTs ?? msg.ts;
  deps.follows.remove(event.channel, threadTs, deps.clock());
  return { kind: "unfollowed", threadTs };
};
