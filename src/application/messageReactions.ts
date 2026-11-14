/**
 * The owner moving the bot's own messages around with a reaction.
 *
 * - 🚼 `baby_symbol` - a thread reply is also sent to the channel
 * - 🧱 `bricks` - a reply that was sent to the channel goes back to living
 *   only in its thread, same ts (`chat.delete` with `broadcast_delete`)
 * - `sausage_punch` - the message is deleted
 * - 🐛 `bug` - the message is badly formatted: a turn is started in its thread
 *   (see `formatFixPrompt`) that fixes it in place with `chat.update`
 *
 * Only the owner, and only on messages the bot wrote: it cannot edit anyone
 * else's anyway, and a reaction from anybody else is just a reaction. Safe to
 * call on every reaction in the workspace.
 */
import type { SlackAdminPort } from "./slackAdmin.ts";

export type MessageAction = "broadcast" | "unbroadcast" | "delete" | "fix_format";

export const MESSAGE_ACTION_REACTIONS: Readonly<Record<string, MessageAction>> = {
  baby_symbol: "broadcast",
  bricks: "unbroadcast",
  sausage_punch: "delete",
  bug: "fix_format",
};

/** `thumbsup::skin-tone-3` is still `thumbsup`. */
export const messageActionFor = (reaction: string): MessageAction | undefined =>
  MESSAGE_ACTION_REACTIONS[reaction.split("::")[0] ?? reaction];

/**
 * The turn a 🐛 starts. Nobody is waiting in the thread, so it says to edit
 * the flagged message and stay quiet unless that is impossible.
 */
export const formatFixPrompt = (channel: string, ts: string): string =>
  `[format fix] The owner flagged message ${ts} in ${channel} with a bug reaction: it is badly formatted. Fetch that message, find the formatting problem (Slack mrkdwn vs Markdown: **double asterisks**, [label](url) links, # headings, markdown tables, broken Block Kit fences, em dashes, and the persona's style rules) and fix it in place with chat.update on that same ts. Post nothing new. When it is fixed, reply with exactly NO_REPLY. Only if you cannot fix it, say why in one short line.`;

export type MessageReactionDeps = {
  slack?: SlackAdminPort;
  ownerSlackId: string;
};

export type MessageReactionEvent = { slackUserId: string; reaction: string; channel: string; ts: string };

export type MessageReactionOutcome =
  | { kind: "broadcast" | "unbroadcast" | "deleted"; ts: string }
  | { kind: "format_flagged"; ts: string; threadTs: string; prompt: string }
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

  if (action === "fix_format") {
    return {
      kind: "format_flagged",
      ts: msg.ts,
      threadTs: isReply ? (msg.threadTs as string) : msg.ts,
      prompt: formatFixPrompt(event.channel, msg.ts),
    };
  }

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
