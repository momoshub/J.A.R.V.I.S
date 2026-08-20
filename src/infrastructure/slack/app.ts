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
import { commandLineOf } from "../../application/commands.ts";
import { annotateMentions, extractMentionIds } from "../../domain/mentions.ts";
import { createSlackStream, type Streamer } from "./stream.ts";

/** Messages longer than this get a "thinking" step before content streams. */
const LONG_MESSAGE_CHARS = 40;

export type SlackAppConfig = {
  botToken: string;
  appToken: string;
  /** Stream replies live via chat.startStream. Falls back to a single post. */
  streamUpdates: boolean;
  /** Bot display name, for log lines. */
  botName: string;
  /** Live label for the "thinking" step (read per message so edits apply). */
  thinkingLabel: () => string;
  /** Live label the thinking step flips to once content arrives. */
  thinkingDoneLabel: () => string;
};

type Deps = RespondDeps & {
  /** Optional logger override, mostly for tests. */
  log?: (msg: string) => void;
};

/** The slice of the Slack WebClient the handler needs (kept minimal for testing). */
export type SlackClient = {
  users: { info: (a: { user: string }) => Promise<unknown> };
  chatStream: (args: Record<string, unknown>) => Streamer;
};

/** A raw Slack message payload, enough to decide whether to handle it. */
export type RawMessage = {
  channel_type?: string;
  user?: string;
  text?: string;
  subtype?: string;
  bot_id?: string;
};

/** Only plain human DMs: reject bot echoes, edits/joins (subtypes) and non-DM channels. */
export const shouldHandleDm = (m: RawMessage): boolean =>
  !m.subtype && !m.bot_id && !!m.user && !!m.text && m.channel_type === "im";

/** Best-effort display name lookup; never throws, worst case returns undefined. */
const fetchDisplayName = async (client: SlackClient, userId: string): Promise<string | undefined> => {
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

export type Incoming = {
  channelId: string;
  userId: string;
  teamId?: string;
  text: string;
  /** Thread to reply in. Streaming requires one, so we always anchor to a ts. */
  threadTs: string;
  client: SlackClient;
  say: (msg: { text: string; thread_ts?: string }) => Promise<unknown>;
};

/**
 * Build the transport-agnostic message handler. Exported so it can be tested
 * with fake clients/streamers without standing up a real Slack connection.
 */
export const createHandler =
  (config: SlackAppConfig, deps: Deps, log: (msg: string) => void) => {
  // Cache resolved display names across messages for this connection.
  const nameCache = new Map<string, string | undefined>();
  const resolveName = async (client: SlackClient, id: string): Promise<string | undefined> => {
    if (nameCache.has(id)) return nameCache.get(id);
    const name = await fetchDisplayName(client, id);
    nameCache.set(id, name);
    return name;
  };
  // Annotate every `<@ID>` in the text with the resolved name for the model.
  const annotate = async (client: SlackClient, text: string): Promise<string> => {
    await Promise.all(extractMentionIds(text).map((id) => resolveName(client, id)));
    return annotateMentions(text, (id) => nameCache.get(id));
  };

  return async (msg: Incoming): Promise<void> => {
    const displayName = await resolveName(msg.client, msg.userId);
    const text = await annotate(msg.client, msg.text);

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
          config.thinkingDoneLabel(),
        )
      : undefined;

    // For long, streamable, non-command messages, show a thinking step first.
    if (
      stream &&
      deps.llm.stream &&
      commandLineOf(text) === undefined &&
      text.trim().length > LONG_MESSAGE_CHARS
    ) {
      stream.showThinking(config.thinkingLabel());
    }

    try {
      const result = await respond(
        deps,
        { channelId: msg.channelId, slackUserId: msg.userId, text, displayName },
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
        .say({ text: "Sorry, I hit an error handling that. Please try again in a moment.", thread_ts: msg.threadTs })
        .catch(() => undefined);
    }
  };
};

export const createSlackApp = (config: SlackAppConfig, deps: Deps) => {
  const log = deps.log ?? ((m: string) => console.log(`[slack] ${m}`));
  const app = new App({ token: config.botToken, appToken: config.appToken, socketMode: true });
  const handle = createHandler(config, deps, log);
  // The real WebClient is a superset of the minimal SlackClient seam.
  const asClient = (client: WebClient) => client as unknown as SlackClient;

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
      client: asClient(client),
      say: say as Incoming["say"],
    });
  });

  // Direct messages -> reply inline. Ignore bot echoes and non-DM channels.
  app.message(async ({ message, client, say, context }) => {
    const m = message as RawMessage & { channel: string; ts: string };
    if (!shouldHandleDm(m)) return;
    await handle({
      channelId: m.channel,
      userId: m.user!,
      teamId: context.teamId,
      text: m.text!,
      threadTs: m.ts,
      client: asClient(client),
      say: say as Incoming["say"],
    });
  });

  // Slash command: /ev <command> <args...> - same registry as `//ev ...` messages.
  // Register a single "/ev" command in the Slack app config; it sub-routes here.
  app.command("/ev", async ({ command, ack, respond: reply }) => {
    await ack();
    const result = await respond(deps, {
      channelId: command.channel_id,
      slackUserId: command.user_id,
      text: `//ev ${command.text ?? ""}`,
      displayName: command.user_name,
    });
    const text = result.kind === "ignored" ? "Nothing to do." : result.text;
    await reply({ response_type: "ephemeral", text });
  });

  return {
    start: async () => {
      await app.start();
      log(`${config.botName} is online via Socket Mode.${config.streamUpdates ? " streaming on." : ""}`);
    },
    stop: async () => {
      await app.stop();
    },
  };
};
