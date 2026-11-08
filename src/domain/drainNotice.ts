/**
 * What somebody is told when they write to a bot that is about to restart.
 *
 * A restart waits for running turns to finish, and while it waits it stops
 * reading the inbox so the wait can actually end. Nothing is lost - the rows
 * stay in the gateway and the next process picks them up - but from the
 * outside that is indistinguishable from being broken. Asked a question and
 * then "??", "??", "<@bot>???" into total silence, the only sane conclusion is
 * that it has died.
 *
 * So the silence gets one message, in the log channel rather than in the
 * threads themselves (posted into a channel or a group DM it was noise for
 * everyone else in it). It lists every thread that is waiting and is edited
 * as more queue up, once per thread, not once per message.
 */
import { reviewRequestIn } from "./reviewRequest.ts";

/** What the waiting thread is told about the restart itself. */
export type DrainInfo = {
  /** Why it restarts, e.g. the change it picks up. Omitted when unknown. */
  readonly reason?: string;
  /** Turns still running that the restart waits for. */
  readonly running: number;
  /** Epoch ms after which it exits anyway, running turns or not. */
  readonly deadlineMs: number;
};

/** The default reason the local API fills in carries nothing worth saying. */
const UNINFORMATIVE = new Set(["", "requested over the local API"]);

/**
 * The one log-channel message. A bare "I'm restarting" left the reader
 * guessing why and for how long, so it names the reason, what it is still
 * waiting on, the latest it can take, and the threads whose messages are
 * held. The time is a Slack date token, so each reader sees it in their own
 * timezone.
 */
export const drainNotice = (info?: DrainInfo, waiting: readonly string[] = []): string => {
  const lines = ["⏸ I'm restarting, so I am not picking up new messages for a moment. They are saved and I will answer them as soon as I am back."];
  const threads = () =>
    waiting.length > 0 ? [`- pending threads (${waiting.length}):`, ...waiting.map((w) => `  - ${w}`)] : [];
  if (!info) return [...lines, ...threads()].join("\n");
  const reason = (info.reason ?? "").trim();
  if (!UNINFORMATIVE.has(reason)) lines.push(`- why: ${reason}`);
  const epoch = Math.floor(info.deadlineMs / 1000);
  const clock = new Date(info.deadlineMs).toISOString().slice(11, 16);
  const latest = `<!date^${epoch}^{time}|${clock} UTC>`;
  lines.push(
    info.running > 0
      ? `- waiting for ${info.running} running ${info.running === 1 ? "turn" : "turns"} to finish, back by ${latest} at the latest`
      : `- nothing is running, back in a few seconds (${latest} at the latest)`,
  );
  return [...lines, ...threads()].join("\n");
};

/**
 * Where an inbox envelope was headed, so a waiting thread can be told.
 *
 * The stored body is Bolt's own `body` for the envelope, which for an events
 * API delivery is the event WRAPPER - `{ type: "event_callback", event: {...} }`
 * - with the event at the top level and no `payload` around it. Reading it as
 * `body.payload.event` matches nothing and notifies nobody, silently, which is
 * exactly how this would have shipped looking fine.
 *
 * Only message events have a thread worth answering in: an interactive press
 * or a slash command is its own thing, and a notice about a restart posted
 * into one would land where nobody is looking.
 *
 * `threadTs` is the thread a reply would land in: the parent for a reply, the
 * message itself for a top-level one, so every waiting thread has a link.
 */
const ASKING_SUBTYPES: ReadonlySet<string> = new Set(["file_share", "thread_broadcast"]);

export const envelopeThread = (
  body: Record<string, unknown>,
): { channel: string; threadTs?: string } | undefined => {
  const event = body.event as Record<string, unknown> | undefined;
  if (!event || event.type !== "message") return undefined;
  // The bot's own messages are not somebody waiting for an answer.
  if (event.bot_id || event.subtype === "bot_message") return undefined;
  // An edit or a delete is not somebody asking either. A message_changed
  // carries the bot id inside `event.message` and no thread_ts at the top, so
  // the bot's own chat.update used to earn a notice at the channel root.
  if (typeof event.subtype === "string" && !ASKING_SUBTYPES.has(event.subtype)) return undefined;
  const channel = typeof event.channel === "string" ? event.channel : "";
  if (!channel) return undefined;
  const threadTs =
    typeof event.thread_ts === "string" ? event.thread_ts : typeof event.ts === "string" ? event.ts : undefined;
  return { channel, ...(threadTs ? { threadTs } : {}) };
};

/** One notice per thread, so repeated asks do not each get an apology. */
export const unnotified = (
  targets: readonly { channel: string; threadTs?: string }[],
  already: ReadonlySet<string>,
): { channel: string; threadTs?: string; key: string }[] => {
  const out: { channel: string; threadTs?: string; key: string }[] = [];
  const seen = new Set(already);
  for (const t of targets) {
    const key = `${t.channel}:${t.threadTs ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...t, key });
  }
  return out;
};

/**
 * Whether a row should wait for the next process while a restart is pending,
 * even though plain chat is still answered on a budget.
 *
 * Only a chat turn can be cut at its budget and picked up again on the same
 * session. A command (typed with a prefix, or a spoken review request), a
 * slash command or a button starts work that cannot be stopped part way, so
 * it would hold the restart open until the cap and then run a second time.
 * Those wait in the inbox, as every row did before budgets existed.
 */
export const waitsForRestart = (
  type: string,
  body: Record<string, unknown>,
  commandPrefixes: readonly string[],
): boolean => {
  if (type !== "events_api") return true;
  const event = body.event as Record<string, unknown> | undefined;
  if (!event || (event.type !== "message" && event.type !== "app_mention")) return false;
  const text = typeof event.text === "string" ? event.text : "";
  const bare = text.replace(/^(\s*<@[^>]+>)+\s*/, "").trimStart().toLowerCase();
  if (commandPrefixes.some((p) => p.trim() && bare.startsWith(p.trim().toLowerCase()))) return true;
  return reviewRequestIn(text) !== undefined;
};
