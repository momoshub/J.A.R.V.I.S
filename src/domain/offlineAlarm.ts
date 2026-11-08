/**
 * Telling people the bot is offline when it cannot tell them anything.
 *
 * The host is a laptop on an unreliable connection. When the network drops,
 * the bot cannot post "I'm offline" - that is exactly the thing it lost - and
 * its Slack presence stays green ("Always Online"), so from a thread an outage
 * looks like a bot ignoring you.
 *
 * So the alarm is armed on Slack's side ahead of time, as a dead man's switch:
 * every tick schedules the offline notice ten minutes out and cancels the
 * previous one. While the host is online the notice never comes due. When it
 * goes offline the cancel cannot reach Slack, and Slack posts it by itself.
 * Once the host is back, the next tick finds the notice in the channel and
 * edits it into "back online, was offline for N min".
 *
 * Nothing is kept in memory or on disk: the last heartbeat rides in the
 * notice's block id, so a restart in the middle of an outage still closes it.
 */

/**
 * How far ahead the notice is armed: the most an outage goes unreported.
 * Must stay well over 5 minutes: in prod Slack posted notices it had answered
 * ok to deleting once they were within a few minutes of due (observed, not
 * documented: at least ~2 min, ~5 assumed). A 3-minute lead meant every
 * cancel was ignored and a notice posted every minute while online. It still
 * posts at the full lead, but after ~5 minutes without a successful tick it
 * can no longer be cancelled.
 */
export const OFFLINE_ALARM_LEAD_MS = 600_000;
/** How often it is re-armed. Well under the lead, so one slow tick is not an alarm. */
export const OFFLINE_ALARM_TICK_MS = 60_000;

/** Per Slack call: far under the ~5 min that fires the notice, so a stalled request cannot outlast it. */
export const OFFLINE_ALARM_REQUEST_TIMEOUT_MS = 20_000;

/**
 * First words of every armed notice: how our scheduled messages are told apart.
 * A shortcode, not the emoji: `chat.scheduledMessages.list` hands the text
 * back with emoji turned into shortcodes, so a literal 🔌 would never match.
 */
export const OFFLINE_PREFIX = ":electric_plug: Jarvis is offline";

const OFFLINE_BLOCK = "jv-offline:";
const ONLINE_BLOCK = "jv-online:";

export type AlarmMessage = {
  readonly text: string;
  readonly blocks: readonly { type: "section"; block_id: string; text: { type: "mrkdwn"; text: string } }[];
};

const section = (blockId: string, text: string): AlarmMessage => ({
  text,
  blocks: [{ type: "section", block_id: blockId, text: { type: "mrkdwn", text } }],
});

/** A Slack date token, so each reader sees their own timezone. */
const at = (ms: number): string => {
  const secs = Math.floor(ms / 1000);
  return `<!date^${secs}^{date_short_pretty} {time}|${new Date(ms).toISOString()}>`;
};

/** "4 min", "1 h 12 min" - rounded up, an outage is never "0 min". */
export const outageLength = (ms: number): string => {
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
};

/** The notice armed at `lastBeatMs`, posted by Slack only if nobody cancels it. */
export const offlineNotice = (lastBeatMs: number): AlarmMessage =>
  section(
    `${OFFLINE_BLOCK}${lastBeatMs}`,
    `${OFFLINE_PREFIX} - the host lost its connection. Last heartbeat ${at(lastBeatMs)}. ` +
      "I will edit this message when I am back. If you wrote to me meanwhile and get no answer, send it again then.",
  );

/** What the notice becomes once the host is back. */
export const onlineNotice = (lastBeatMs: number, nowMs: number): AlarmMessage =>
  section(
    `${ONLINE_BLOCK}${lastBeatMs}`,
    `✅ Jarvis is back online - offline for about ${outageLength(nowMs - lastBeatMs)} (since ${at(lastBeatMs)}). ` +
      "If you wrote to me in that window and got no answer, send it again.",
  );

/** The last heartbeat of an offline notice still open in the channel, or undefined. */
export const openOfflineBeat = (blocks: readonly unknown[] | undefined): number | undefined => {
  for (const b of blocks ?? []) {
    const id = (b as { block_id?: unknown }).block_id;
    if (typeof id !== "string" || !id.startsWith(OFFLINE_BLOCK)) continue;
    const ms = Number(id.slice(OFFLINE_BLOCK.length));
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return undefined;
};

/** Is this scheduled message one of our armed notices? */
export const isArmedNotice = (text: string | undefined): boolean => (text ?? "").startsWith(OFFLINE_PREFIX);
