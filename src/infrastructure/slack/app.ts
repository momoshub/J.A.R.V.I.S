/**
 * Slack adapter (Socket Mode).
 *
 * Kept deliberately thin: it listens for direct messages and @-mentions, turns a
 * Slack event into a neutral `InboundMessage`, hands it to `respond`, and posts
 * the answer back. No business logic lives here.
 */
import { App } from "@slack/bolt";
import { respond, type RespondDeps } from "../../application/respond.ts";

export type SlackAppConfig = {
  botToken: string;
  appToken: string;
};

type Deps = RespondDeps & {
  /** Optional logger override, mostly for tests. */
  log?: (msg: string) => void;
};

/** Best-effort display name lookup; never throws, worst case returns undefined. */
const fetchDisplayName = async (
  client: { users: { info: (a: { user: string }) => Promise<unknown> } },
  userId: string,
): Promise<string | undefined> => {
  try {
    const res = (await client.users.info({ user: userId })) as {
      user?: { profile?: { display_name?: string; real_name?: string }; real_name?: string };
    };
    const p = res.user?.profile;
    return p?.display_name || p?.real_name || res.user?.real_name || undefined;
  } catch {
    return undefined;
  }
};

export const createSlackApp = (config: SlackAppConfig, deps: Deps) => {
  const log = deps.log ?? ((m: string) => console.log(`[slack] ${m}`));
  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
  });

  const handle = async (
    channelId: string,
    userId: string,
    text: string,
    client: Parameters<typeof fetchDisplayName>[0],
    say: (msg: { text: string; thread_ts?: string }) => Promise<unknown>,
    threadTs?: string,
  ) => {
    const displayName = await fetchDisplayName(client, userId);
    try {
      const result = await respond(deps, { channelId, slackUserId: userId, text, displayName });
      if (result.kind === "ignored") return;
      await say({ text: result.text, thread_ts: threadTs });
    } catch (err) {
      log(`respond failed: ${err instanceof Error ? err.message : String(err)}`);
      await say({
        text: "Something in my circuits misfired handling that. Try again in a moment.",
        thread_ts: threadTs,
      }).catch(() => undefined);
    }
  };

  // @-mentions in channels -> reply in the same thread.
  app.event("app_mention", async ({ event, client, say }) => {
    const e = event as { channel: string; user?: string; text: string; ts: string; thread_ts?: string };
    if (!e.user) return;
    await handle(e.channel, e.user, e.text, client, say as never, e.thread_ts ?? e.ts);
  });

  // Direct messages -> reply inline. Ignore bot echoes and non-DM channels.
  app.message(async ({ message, client, say }) => {
    const m = message as {
      channel: string;
      channel_type?: string;
      user?: string;
      text?: string;
      subtype?: string;
      bot_id?: string;
    };
    if (m.subtype || m.bot_id || !m.user || !m.text) return;
    if (m.channel_type !== "im") return;
    await handle(m.channel, m.user, m.text, client, say as never);
  });

  return {
    start: async () => {
      await app.start();
      log("E.V. is online via Socket Mode.");
    },
    stop: async () => {
      await app.stop();
    },
  };
};
