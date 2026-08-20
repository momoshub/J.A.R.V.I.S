/**
 * Slack adapter (Socket Mode).
 *
 * Listens for direct messages and @-mentions, turns a Slack event into a neutral
 * `InboundMessage`, and hands it to `respond`. When streaming is enabled and the
 * brain supports it, the reply streams live via Slack's text-streaming API with
 * tool calls shown as a task timeline; otherwise it posts once. No business
 * logic lives here.
 */
import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { respond, type RespondDeps } from "../../application/respond.ts";
import { parseCommand } from "../../application/commands.ts";
import { createSlackStream, type Streamer } from "./stream.ts";

/** Messages longer than this get a "thinking" step before content streams. */
const LONG_MESSAGE_CHARS = 40;
const THINKING_LABEL = "☄️ burning acme token..";

export type SlackAppConfig = {
  botToken: string;
  appToken: string;
  /** Stream replies live via chat.startStream. Falls back to a single post. */
  streamUpdates: boolean;
};

type Deps = RespondDeps & {
  /** Optional logger override, mostly for tests. */
  log?: (msg: string) => void;
};

/** Best-effort display name lookup; never throws, worst case returns undefined. */
const fetchDisplayName = async (client: WebClient, userId: string): Promise<string | undefined> => {
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

type Incoming = {
  channelId: string;
  userId: string;
  teamId?: string;
  text: string;
  /** Thread to reply in. Streaming requires one, so we always anchor to a ts. */
  threadTs: string;
  client: WebClient;
  say: (msg: { text: string; thread_ts?: string }) => Promise<unknown>;
};

export const createSlackApp = (config: SlackAppConfig, deps: Deps) => {
  const log = deps.log ?? ((m: string) => console.log(`[slack] ${m}`));
  const app = new App({ token: config.botToken, appToken: config.appToken, socketMode: true });

  const handle = async (msg: Incoming) => {
    const displayName = await fetchDisplayName(msg.client, msg.userId);

    const stream = config.streamUpdates
      ? createSlackStream(
          () =>
            msg.client.chatStream({
              channel: msg.channelId,
              thread_ts: msg.threadTs,
              recipient_user_id: msg.userId,
              recipient_team_id: msg.teamId,
              task_display_mode: "timeline",
            }) as Streamer,
          log,
        )
      : undefined;

    // For long, streamable, non-command messages, show a thinking step first.
    if (
      stream &&
      deps.llm.stream &&
      parseCommand(msg.text) === undefined &&
      msg.text.trim().length > LONG_MESSAGE_CHARS
    ) {
      stream.showThinking(THINKING_LABEL);
    }

    try {
      const result = await respond(
        deps,
        { channelId: msg.channelId, slackUserId: msg.userId, text: msg.text, displayName },
        stream?.sink,
      );
      if (result.kind === "ignored") return;

      // If the reply streamed successfully, Slack already has it; otherwise post.
      const streamed = stream?.started ? await stream.finish() : false;
      if (!streamed) await msg.say({ text: result.text, thread_ts: msg.threadTs });
    } catch (err) {
      log(`respond failed: ${err instanceof Error ? err.message : String(err)}`);
      if (stream?.started) await stream.finish().catch(() => undefined);
      await msg
        .say({ text: "Something in my circuits misfired handling that. Try again in a moment.", thread_ts: msg.threadTs })
        .catch(() => undefined);
    }
  };

  // @-mentions in channels -> reply in the same thread.
  app.event("app_mention", async ({ event, client, say, context }) => {
    const e = event as { channel: string; user?: string; text: string; ts: string; thread_ts?: string };
    if (!e.user) return;
    await handle({
      channelId: e.channel,
      userId: e.user,
      teamId: context.teamId,
      text: e.text,
      threadTs: e.thread_ts ?? e.ts,
      client,
      say: say as Incoming["say"],
    });
  });

  // Direct messages -> reply inline. Ignore bot echoes and non-DM channels.
  app.message(async ({ message, client, say, context }) => {
    const m = message as {
      channel: string;
      channel_type?: string;
      user?: string;
      text?: string;
      ts: string;
      subtype?: string;
      bot_id?: string;
    };
    if (m.subtype || m.bot_id || !m.user || !m.text) return;
    if (m.channel_type !== "im") return;
    await handle({
      channelId: m.channel,
      userId: m.user,
      teamId: context.teamId,
      text: m.text,
      threadTs: m.ts,
      client,
      say: say as Incoming["say"],
    });
  });

  return {
    start: async () => {
      await app.start();
      log(`E.V. is online via Socket Mode.${config.streamUpdates ? " streaming on." : ""}`);
    },
    stop: async () => {
      await app.stop();
    },
  };
};
