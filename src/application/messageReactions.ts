/**
 * The owner moving the bot's own messages around with a reaction.
 *
 * - 🚼 `baby_symbol` - a thread reply is also sent to the channel
 * - 🧱 `bricks` - a reply that was sent to the channel goes back to living
 *   only in its thread, same ts (`chat.delete` with `broadcast_delete`)
 * - `sausage_punch` - the message is deleted
 *
 * Only the owner, and only on messages the bot wrote: it cannot edit anyone
 * else's anyway, and a reaction from anybody else is just a reaction. Safe to
 * call on every reaction in the workspace.
 */
import type { SlackAdminPort } from "./slackAdmin.ts";

export type MessageAction = "broadcast" | "unbroadcast" | "delete";

export const MESSAGE_ACTION_REACTIONS: Readonly<Record<string, MessageAction>> = {
  baby_symbol: "broadcast",
  bricks: "unbroadcast",
  sausage_punch: "delete",
};

/** `thumbsup::skin-tone-3` is still `thumbsup`. */
export const messageActionFor = (reaction: string): MessageAction | undefined =>
  MESSAGE_ACTION_REACTIONS[reaction.split("::")[0] ?? reaction];

export type MessageReactionDeps = {
  slack?: SlackAdminPort;
  ownerSlackId: string;
};

export type MessageReactionEvent = { slackUserId: string; reaction: string; channel: string; ts: string };

export type MessageReactionOutcome =
  | { kind: "broadcast" | "unbroadcast" | "deleted"; ts: string }
  | { kind: "ignored"; why: string };

export const actOnMessageReaction = async (
  deps: MessageReactionDeps,
  event: MessageReactionEvent,
): Promise<MessageReactionOutcome> => {
  const action = messageActionFor(event.reaction);
  if (!action) return { kind: "ignored", why: "not a message action" };
  if (event.slackUserId !== deps.ownerSlackId) return { kind: "ignored", why: "not the owner" };
  const slack = deps.slack;
  if (!slack?.lookup) return { kind: "ignored", why: "no slack" };

  const [me, msg] = await Promise.all([slack.botUserId(), slack.lookup(event.channel, event.ts)]);
  if (!msg) return { kind: "ignored", why: "message not found" };
  if (!me || msg.userId !== me) return { kind: "ignored", why: "not my message" };

  const isReply = msg.threadTs !== undefined && msg.threadTs !== msg.ts;

  if (action === "delete") {
    await slack.remove(event.channel, msg.ts);
    return { kind: "deleted", ts: msg.ts };
  }

  if (action === "broadcast") {
    if (!isReply) return { kind: "ignored", why: "not a thread reply" };
    if (msg.broadcast) return { kind: "ignored", why: "already in the channel" };
    if (!slack.broadcast) return { kind: "ignored", why: "no slack" };
    await slack.broadcast(event.channel, msg.ts);
    return { kind: "broadcast", ts: msg.ts };
  }

  if (!isReply || !msg.broadcast) return { kind: "ignored", why: "not sent to the channel" };
  if (!slack.unbroadcast) return { kind: "ignored", why: "no slack" };
  await slack.unbroadcast(event.channel, msg.ts);
  return { kind: "unbroadcast", ts: msg.ts };
};
