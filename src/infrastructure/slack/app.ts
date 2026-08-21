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
import { decideAccessRequest } from "../../application/accessRequests.ts";
import { APPROVE_ACTION, decideCommandApproval, REJECT_ACTION } from "../../application/commandLimits.ts";
import { commandLineOf, dispatchCommand } from "../../application/commands.ts";
import { annotateMentions, extractMentionIds } from "../../domain/mentions.ts";
import { createSlackStream, type Streamer } from "./stream.ts";

/** Messages longer than this get a "thinking" step before content streams. */

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
  /** Silence before a thinking card appears; defaults to THINKING_AFTER_MS. */
  thinkingAfterMs?: number;
  /** Message command prefix (e.g. "X/ev") and the Slack slash command name. */
  commandPrefix: string;
  slashCommand: string;
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
  /** Set when the DM is a reply inside a thread; absent on a top-level message. */
  thread_ts?: string;
};

/**
 * The thread a message belongs to: its parent when it is a reply, otherwise
 * itself. This is the key the bot's memory is scoped by, so getting it wrong
 * either splits one conversation apart or merges two that are unrelated.
 */
export const threadKeyOf = (m: { ts: string; thread_ts?: string }): string => m.thread_ts ?? m.ts;

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

/** The slice of Bolt's slash-command listener args we use. */
type SlashArgs = {
  command: { channel_id: string; user_id: string; user_name?: string; text?: string };
  ack: () => Promise<unknown>;
  respond: (msg: { response_type?: "ephemeral" | "in_channel"; text: string }) => Promise<unknown>;
};

/** The slice of Bolt's action payload we use (kept minimal for testing). */
export type ApprovalArgs = {
  ack: () => Promise<unknown>;
  body: { user?: { id?: string }; channel?: { id?: string }; message?: { ts?: string } };
  action: { action_id?: string; value?: string };
};

export type Incoming = {
  channelId: string;
  userId: string;
  teamId?: string;
  text: string;
  /** Thread to reply in. Streaming requires one, so we always anchor to a ts. */
  threadTs: string;
  /** ts of this message itself, so the bot can react to it later. */
  messageTs: string;
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

    // Arm a thinking step for streamable, non-command messages. It only appears
    // if the turn is still silent a few seconds in - how long the answer takes
    // is the thing worth reassuring about, and message length never predicted it.
    if (stream && deps.llm.stream && commandLineOf(text, config.commandPrefix) === undefined) {
      stream.showThinkingAfter(config.thinkingLabel(), config.thinkingAfterMs);
    }

    try {
      const result = await respond(
        deps,
        {
          channelId: msg.channelId,
          slackUserId: msg.userId,
          text,
          displayName,
          threadTs: msg.threadTs,
          messageTs: msg.messageTs,
          viaSlash: false,
        },
        stream?.sink,
      );
      log(`handled user=${msg.userId} channel=${msg.channelId} kind=${result.kind}`);
      if (result.kind === "ignored") return;

      // If the reply streamed successfully, Slack already has it; otherwise post.
      // An empty reply means the command already delivered itself into the thread
      // (e.g. review posts progress + result directly), so post nothing more.
      const streamed = stream?.started ? await stream.finish() : false;
      if (!streamed && result.text.trim()) await msg.say({ text: result.text, thread_ts: msg.threadTs });
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
      threadTs: threadKeyOf(e),
      messageTs: e.ts,
      client: asClient(client),
      say: say as Incoming["say"],
    });
  });

  // Approve / Reject on a held command. Only owner and admin get anywhere.
  const onApprovalButton = async ({ ack, body, action }: ApprovalArgs) => {
    await ack();
    const clicked = body.user?.id;
    const value = action?.value;
    if (!clicked || !value) return;
    try {
      const outcome = await decideCommandApproval(
        deps,
        { slackUserId: clicked, actionId: action.action_id ?? "", value },
        ({ actor, line, channelId, threadTs }) =>
          dispatchCommand(deps, actor, channelId, line, {
            prefix: config.commandPrefix,
            slash: config.slashCommand,
            threadTs,
            preApproved: true,
            reply: deps.slack ? (text: string) => deps.slack!.post(channelId, text, threadTs) : undefined,
          }),
      );
      log(`command approval ${outcome.kind}`);
      // Settle the notice so a decided request cannot be clicked again.
      const settled =
        outcome.kind === "approved"
          ? `✅ approved - <@${outcome.requester}> ran \`${outcome.line}\``
          : outcome.kind === "rejected"
            ? `❌ rejected <@${outcome.requester}>'s command`
            : undefined;
      if (settled && body.channel?.id && body.message?.ts) {
        await deps.slack?.settleInteractive(body.channel.id, body.message.ts, settled).catch(() => undefined);
      }
    } catch (err) {
      log(`command approval failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  app.action({ action_id: APPROVE_ACTION }, onApprovalButton as never);
  app.action({ action_id: REJECT_ACTION }, onApprovalButton as never);

  // The owner reacting on an access-request notice decides it.
  app.event("reaction_added", async ({ event }) => {
    const e = event as {
      user?: string;
      reaction?: string;
      item?: { type?: string; channel?: string; ts?: string };
    };
    if (!e.user || !e.reaction || e.item?.type !== "message" || !e.item.channel || !e.item.ts) return;
    try {
      const outcome = await decideAccessRequest(deps, {
        slackUserId: e.user,
        reaction: e.reaction,
        channel: e.item.channel,
        ts: e.item.ts,
      });
      if (outcome.kind !== "ignored") {
        log(`access ${outcome.kind} for ${outcome.request.slackUserId}`);
      }
    } catch (err) {
      log(`access request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
      threadTs: threadKeyOf(m),
      messageTs: m.ts,
      client: asClient(client),
      say: say as Incoming["say"],
    });
  });

  // Slash commands, all routed through the same command registry as the message
  // prefix. Register each in the Slack app config. The configured slash command is
  // the general dispatcher; /rv, /br, /jrp are shortcuts to those commands.
  const runSlash =
    (sub: string) =>
    async ({ command, ack, respond: reply }: SlashArgs) => {
      await ack();
      const line = `${sub} ${command.text ?? ""}`.trim();
      const result = await respond(deps, {
        channelId: command.channel_id,
        slackUserId: command.user_id,
        text: `${config.commandPrefix} ${line}`,
        displayName: command.user_name,
        viaSlash: true,
      });
      // An empty reply means the command delivered itself to the user's DM
      // (progress + result), so the slash just acknowledges quietly.
      const text =
        result.kind === "ignored"
          ? "Nothing to do."
          : result.text.trim() || "on it — I'll reply in your DM 📩";
      await reply({ response_type: "ephemeral", text });
    };
  app.command(config.slashCommand, runSlash(""));
  app.command("/rv", runSlash("review"));
  app.command("/br", runSlash("bomb"));
  app.command("/jrp", runSlash("reply"));

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
