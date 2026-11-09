/**
 * Shared plumbing for the end-to-end tests (see `slackBlockKit.e2e.ts` for the
 * why): the env gate, one root message per file under which everything is
 * posted, reading the thread back, and cleaning up.
 *
 * Not a test file itself - nothing here runs unless an e2e file imports it.
 */
import { WebClient } from "@slack/web-api";

export const TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
export const CHANNEL = process.env.JARVIS_E2E_CHANNEL ?? "C0TEST00005";
export const KEEP = process.env.JARVIS_E2E_KEEP === "1";
export const enabled = process.env.JARVIS_E2E === "1" && TOKEN !== "";

export type SlackMessage = {
  ts?: string;
  thread_ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  blocks?: { type: string }[];
  files?: { id?: string }[];
};

export type E2eThread = {
  web: WebClient;
  rootTs: string;
  botUserId: string;
  teamId: string;
  /** Remember a ts so `cleanup` deletes it. */
  track: (ts: string | undefined) => void;
  replies: () => Promise<SlackMessage[]>;
  /** Poll the thread until `pick` finds something (Slack is eventually consistent). */
  waitFor: <T>(pick: (messages: SlackMessage[]) => T | undefined, tries?: number) => Promise<T | undefined>;
  cleanup: () => Promise<void>;
};

/** Post this file's root message and hand back the thread it owns. */
export const openThread = async (label: string): Promise<E2eThread> => {
  const web = new WebClient(TOKEN);
  const auth = await web.auth.test();
  const root = await web.chat.postMessage({
    channel: CHANNEL,
    text: `jarvis e2e ${label} ${new Date().toISOString()} (deleted when done)`,
  });
  const rootTs = root.ts ?? "";
  if (!rootTs) throw new Error("could not post the e2e root message");
  console.log(`  e2e ${label}: root ${CHANNEL} ${rootTs}`);
  const posted = new Set<string>();
  const replies = async (): Promise<SlackMessage[]> => {
    const res = await web.conversations.replies({ channel: CHANNEL, ts: rootTs, limit: 200 });
    return (res.messages ?? []) as SlackMessage[];
  };
  return {
    web,
    rootTs,
    botUserId: auth.user_id ?? "",
    teamId: auth.team_id ?? "",
    track: (ts) => {
      if (ts) posted.add(ts);
    },
    replies,
    waitFor: async (pick, tries = 20) => {
      for (let i = 0; i < tries; i++) {
        const found = pick(await replies());
        if (found !== undefined) return found;
        await Bun.sleep(500);
      }
      return undefined;
    },
    cleanup: async () => {
      if (KEEP) return;
      // Whatever landed in the thread, tracked or not, goes; then the root.
      const inThread = (await replies().catch(() => [])).flatMap((m) => (m.ts && m.ts !== rootTs ? [m.ts] : []));
      for (const ts of [...new Set([...posted, ...inThread])].reverse().concat(rootTs)) {
        await web.chat
          .delete({ channel: CHANNEL, ts })
          .catch((e: unknown) => console.log(`  cleanup ${ts}: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  };
};
