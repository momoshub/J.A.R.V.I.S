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
import {
  decodeRequest,
  submitClaudeToken,
  TOKEN_ACTION,
  TOKEN_BLOCK,
  TOKEN_INPUT,
  TOKEN_VIEW,
} from "../../application/claudeTokens.ts";
import {
  decodeTotpRequest,
  submitTotpSecret,
  TOTP_ACTION,
  TOTP_BLOCK,
  TOTP_INPUT,
  TOTP_VIEW,
} from "../../application/totp.ts";
import { tokenGuide, tokenHint, TOKEN_PREFIX } from "../../domain/claudeToken.ts";
import { commandLineOf, dispatchCommand } from "../../application/commands.ts";
import { annotateMentions, extractMentionIds } from "../../domain/mentions.ts";
import { createSlackStream, type Streamer } from "./stream.ts";
import {
  CONNECTION_GRACE_MS,
  describeConnection,
  shouldGiveUp,
  type ConnectionHealth,
  type ConnectionState,
} from "../../domain/connectionHealth.ts";

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
  /**
   * How long the socket may stay down before the process gives up on itself.
   * Exposed for tests; production wants the default.
   */
  connectionGraceMs?: number;
  /** How often to check. */
  connectionCheckMs?: number;
  /**
   * What to do when the socket is gone for good. Defaults to exiting, so the
   * supervisor restarts into a fresh connection; tests pass their own.
   */
  onConnectionLost?: (health: ConnectionHealth) => void;
};

type Deps = RespondDeps & {
  /** Optional logger override, mostly for tests. */
  log?: (msg: string) => void;
};

/** The slice of the Slack WebClient the handler needs (kept minimal for testing). */
export type SlackClient = {
  users: { info: (a: { user: string }) => Promise<unknown> };
  chatStream: (args: Record<string, unknown>) => Streamer;
  chat: { update: (a: Record<string, unknown>) => Promise<unknown> };
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
  command: {
    channel_id: string;
    user_id: string;
    user_name?: string;
    text?: string;
    /** Only a slash command and a button click carry one, and a modal needs it. */
    trigger_id?: string;
  };
  ack: () => Promise<unknown>;
  respond: (msg: { response_type?: "ephemeral" | "in_channel"; text: string }) => Promise<unknown>;
  /** Bolt's WebClient. Narrowed at the one call site that needs views.open. */
  client: unknown;
};

/** The one WebClient method used outside the streaming seam. */
type ViewOpener = { views: { open: (a: Record<string, unknown>) => Promise<unknown> } };

/** The slice of Bolt's action payload we use (kept minimal for testing). */
export type ApprovalArgs = {
  ack: () => Promise<unknown>;
  body: { user?: { id?: string }; channel?: { id?: string }; message?: { ts?: string } };
  action: { action_id?: string; value?: string };
};

/** The slice of a block-actions payload needed to open a modal from a button. */
type ModalButtonArgs = {
  ack: () => Promise<unknown>;
  body: { user?: { id?: string }; trigger_id?: string };
  action: { value?: string };
  client: ViewOpener;
};

/** The slice of a view_submission payload we use. */
type ViewArgs = {
  ack: (res?: Record<string, unknown>) => Promise<unknown>;
  body: { user?: { id?: string } };
  view: {
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, { value?: string | null }>> };
  };
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
  say: (msg: { text: string; thread_ts?: string; reply_broadcast?: boolean }) => Promise<unknown>;
};

/**
 * Whether the reply should also show up in the channel, not just the thread.
 *
 * The bot always answers in a thread (streaming needs a ts to anchor to), so a
 * question asked at top level would otherwise get an answer nobody sees without
 * opening the thread. When the bot is the one who opened that thread, broadcast.
 * Inside an existing thread everyone is already looking, so stay quiet there.
 */
export const shouldBroadcast = (m: { threadTs: string; messageTs: string }): boolean =>
  m.threadTs === m.messageTs;

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
      const broadcast = shouldBroadcast(msg);
      if (streamed) {
        // chat.startStream takes no reply_broadcast, so promote the finished
        // message instead. Sending no content leaves the streamed blocks intact.
        if (broadcast && stream?.ts) {
          await msg.client.chat
            .update({ channel: msg.channelId, ts: stream.ts, reply_broadcast: true })
            .catch((e: unknown) => log(`broadcast failed: ${e instanceof Error ? e.message : String(e)}`));
        }
      } else if (result.text.trim()) {
        await msg.say({ text: result.text, thread_ts: msg.threadTs, ...(broadcast ? { reply_broadcast: true } : {}) });
      }
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

  // Socket Mode goes deaf silently: the process lives, the supervisor sees it
  // running, and nothing distinguishes "nobody is talking to me" from "I cannot
  // hear anyone". Watch the connection itself and exit if it does not come
  // back, which is the only way KeepAlive can do its job.
  const health: ConnectionHealth = { state: "unknown", since: Date.now() };
  const enter = (state: ConnectionState): void => {
    if (health.state === state) return;
    health.state = state;
    health.since = Date.now();
    log(`socket ${state}`);
  };
  const socket = (app as unknown as { receiver?: { client?: { on?: (e: string, f: () => void) => void } } })
    .receiver?.client;
  if (socket?.on) {
    socket.on("connected", () => enter("connected"));
    socket.on("connecting", () => enter("connecting"));
    socket.on("reconnecting", () => enter("reconnecting"));
    socket.on("disconnecting", () => enter("disconnected"));
    socket.on("disconnected", () => enter("disconnected"));
    // Any traffic at all proves the socket is carrying events, whatever the
    // state machine believes about itself.
    socket.on("slack_event", () => enter("connected"));
  } else {
    log("socket state is not observable on this Bolt build - the watchdog is off");
  }

  const graceMs = config.connectionGraceMs ?? CONNECTION_GRACE_MS;
  const giveUp =
    config.onConnectionLost ??
    ((h: ConnectionHealth) => {
      log(`giving up: ${describeConnection(h, Date.now())}. Exiting so the supervisor restarts me.`);
      process.exit(1);
    });
  let watchdog: ReturnType<typeof setInterval> | undefined;
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

  // A token never travels as a Slack message: the button opens a modal, and a
  // modal's input is not posted, not searchable, and not in the bot's memory.
  const tokenModal = (metadata: string) => ({
    type: "modal",
    callback_id: TOKEN_VIEW,
    private_metadata: metadata,
    title: { type: "plain_text", text: "Claude Code token" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: tokenGuide(config.slashCommand) } },
      {
        type: "input",
        block_id: TOKEN_BLOCK,
        label: { type: "plain_text", text: "Your token" },
        hint: {
          type: "plain_text",
          text: `starts with ${TOKEN_PREFIX} - stored encrypted, never shown in a channel`,
        },
        element: {
          type: "plain_text_input",
          action_id: TOKEN_INPUT,
          placeholder: { type: "plain_text", text: `${TOKEN_PREFIX}...` },
        },
      },
    ],
  });

  app.action({ action_id: TOKEN_ACTION }, (async ({ ack, body, action, client }: ModalButtonArgs) => {
    await ack();
    if (!body.trigger_id) return;
    try {
      await client.views.open({ trigger_id: body.trigger_id, view: tokenModal(action.value ?? "") });
    } catch (err) {
      log(`token modal failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }) as never);

  app.view(TOKEN_VIEW, (async ({ ack, body, view }: ViewArgs) => {
    const userId = body.user?.id;
    const token = view.state?.values?.[TOKEN_BLOCK]?.[TOKEN_INPUT]?.value ?? "";
    const outcome = submitClaudeToken(deps, {
      slackUserId: userId ?? "",
      token,
      request: decodeRequest(view.private_metadata),
    });
    if (outcome.kind !== "saved") {
      // Keep the modal open with the reason on the field, so a mistyped paste is
      // fixed where it happened rather than re-explained in a channel.
      const error =
        outcome.kind === "invalid" ? outcome.error.replace(/`/g, "") : "I have nowhere to store that right now";
      await ack({ response_action: "errors", errors: { [TOKEN_BLOCK]: error } });
      return;
    }
    await ack();
    if (!userId) return;

    const req = outcome.request;
    const channel = req?.channelId;
    const saved = `🔐 got it, token ${tokenHint(token)} saved for <@${userId}>`;
    try {
      if (channel) await deps.slack?.post(channel, saved, req?.threadTs);
      else await deps.slack?.postDm(userId, saved);
      log(`claude token saved for ${userId}`);
      // Resume whatever was blocked on it, so nobody has to type it twice.
      const actor = deps.users.get(userId);
      if (req?.line && channel && actor) {
        await dispatchCommand(deps, actor, channel, req.line, {
          prefix: config.commandPrefix,
          slash: config.slashCommand,
          threadTs: req.threadTs,
          reply: deps.slack ? (text: string) => deps.slack!.post(channel, text, req.threadTs) : undefined,
        });
      }
    } catch (err) {
      log(`token follow-up failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }) as never);

  // A 2FA setup key travels the same way a token does, and for the same reason:
  // a modal's input is not a message, so it is not in history, not searchable,
  // and not in the bot's memory. The label rides along in private_metadata.
  const totpModal = (metadata: string) => {
    const label = decodeTotpRequest(metadata)?.label ?? "this login";
    return {
      type: "modal",
      callback_id: TOTP_VIEW,
      private_metadata: metadata,
      title: { type: "plain_text", text: "2FA setup key" },
      submit: { type: "plain_text", text: "Save" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Filed under \`${label}\`. Paste the \`otpauth://\` link the QR code encodes, or the base32 key printed beside it.`,
          },
        },
        {
          type: "input",
          block_id: TOTP_BLOCK,
          label: { type: "plain_text", text: "Setup key" },
          hint: {
            type: "plain_text",
            text: "stored encrypted, never shown in a channel - only the six digits come back out",
          },
          element: {
            type: "plain_text_input",
            action_id: TOTP_INPUT,
            placeholder: { type: "plain_text", text: "otpauth://totp/..." },
          },
        },
      ],
    };
  };

  app.action({ action_id: TOTP_ACTION }, (async ({ ack, body, action, client }: ModalButtonArgs) => {
    await ack();
    if (!body.trigger_id) return;
    try {
      await client.views.open({ trigger_id: body.trigger_id, view: totpModal(action.value ?? "") });
    } catch (err) {
      log(`2fa modal failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }) as never);

  app.view(TOTP_VIEW, (async ({ ack, body, view }: ViewArgs) => {
    const userId = body.user?.id;
    const secret = view.state?.values?.[TOTP_BLOCK]?.[TOTP_INPUT]?.value ?? "";
    const outcome = submitTotpSecret(deps, {
      slackUserId: userId ?? "",
      secret,
      request: decodeTotpRequest(view.private_metadata),
    });
    if (outcome.kind !== "saved") {
      // Keep the modal open with the reason on the field, so a bad paste is
      // fixed where it happened rather than re-explained in a channel.
      const error =
        outcome.kind === "invalid" ? outcome.error.replace(/`/g, "") : "I have nowhere to store that right now";
      await ack({ response_action: "errors", errors: { [TOTP_BLOCK]: error } });
      return;
    }
    await ack();
    if (!userId) return;

    const req = outcome.request;
    const channel = req?.channelId;
    // The key itself is never echoed - only what it is called and who it is for.
    const saved = `🔐 setup key saved as \`${outcome.label}\`${outcome.account ? ` (${outcome.account})` : ""}. \`${config.slashCommand} 2fa ${outcome.label}\` for a code.`;
    try {
      if (channel) await deps.slack?.post(channel, saved, req?.threadTs);
      else await deps.slack?.postDm(userId, saved);
      log(`totp secret saved as ${outcome.label} by ${userId}`);
    } catch (err) {
      log(`2fa follow-up failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }) as never);

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
    async ({ command, ack, respond: reply, client }: SlashArgs) => {
      await ack();
      const line = `${sub} ${command.text ?? ""}`.trim();
      // `token` is the one command whose input must not be a message, and a
      // slash command is the only place a trigger_id exists to open a box with.
      // Anyone off the allowlist gets the ordinary path, which turns them away.
      if (/^token(\s+(add|set))?$/i.test(line) && command.trigger_id && deps.users.get(command.user_id)) {
        try {
          await (client as ViewOpener).views.open({
            trigger_id: command.trigger_id,
            view: tokenModal(JSON.stringify({ channelId: command.channel_id })),
          });
          await reply({ response_type: "ephemeral", text: "opening a box for it 🔐" });
          return;
        } catch (err) {
          log(`token modal failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
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
      // `start()` resolving means the socket opened, even if the event did not
      // reach us before this point.
      if (health.state === "unknown") enter("connected");
      if (socket?.on) {
        watchdog = setInterval(() => {
          if (shouldGiveUp(health, Date.now(), graceMs)) giveUp(health);
        }, config.connectionCheckMs ?? 30_000);
        // A watchdog is not a reason to keep an otherwise-finished process alive.
        watchdog.unref?.();
      }
      log(`${config.botName} is online via Socket Mode.${config.streamUpdates ? " streaming on." : ""}`);
    },
    stop: async () => {
      if (watchdog) clearInterval(watchdog);
      await app.stop();
    },
    /** Whether the bot can currently hear Slack, for the dashboard. */
    health: () => ({ ...health }),
  };
};
