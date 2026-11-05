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
import { forHowLong } from "../../domain/runControl.ts";
import {
  AGENT_SESSION_STOPPED,
  type AgentSessionStoppedEvent,
  planSessionStop,
  sessionStoppedNotice,
} from "../../domain/agentSession.ts";
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
import { commandLineOf, dispatchCommand, listCommandInfo } from "../../application/commands.ts";
import {
  clip,
  decodeMenuRequest,
  encodeMenuRequest,
  MENU_BLOCK,
  MENU_INPUT,
  MENU_RUN_PATTERN,
  MENU_SELECT_ACTION,
  MENU_VIEW,
  needsArguments,
} from "../../domain/commandMenu.ts";
import { annotateMentions, extractMentionIds } from "../../domain/mentions.ts";
import { isTimeout } from "../../domain/threadSession.ts";
import { toMrkdwn } from "../../domain/slackFormat.ts";
import { toBlockMessage, type Block } from "../../domain/blockKit.ts";
import { couldFollowThread, followVerdict, isOneOnOneThread } from "../../domain/threadFollow.ts";
import { collapsedBlocks, collapseSteps } from "../../domain/collapseSteps.ts";
import { isSilenceNote } from "../../domain/silence.ts";
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

/** A menu press: a button, or a pick from the command select. */
type MenuArgs = {
  ack: () => Promise<unknown>;
  body: {
    user?: { id?: string };
    channel?: { id?: string };
    message?: { ts?: string; thread_ts?: string };
    trigger_id?: string;
  };
  action: { action_id?: string; value?: string; selected_option?: { value?: string } };
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
  /** An untagged reply under a thread this bot started. */
  following?: boolean;
  say: (msg: { text: string; blocks?: Block[]; thread_ts?: string; reply_broadcast?: boolean }) => Promise<unknown>;
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

    // When following, held until the turn is plainly working: most of those
    // say nothing, and a stream opened up front is in the channel before
    // anyone can check it is not a note about staying quiet.
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
          { holdUntilWorking: msg.following === true },
        )
      : undefined;

    // Arm a thinking step for streamable, non-command messages. It only appears
    // if the turn is still silent a few seconds in - how long the answer takes
    // is the thing worth reassuring about, and message length never predicted it.
    // Not when following: nobody asked, so nobody is waiting, and a "thinking"
    // card in a channel announces a turn that is quite likely to say nothing.
    if (
      stream &&
      deps.llm.stream &&
      !msg.following &&
      commandLineOf(text, config.commandPrefix) === undefined
    ) {
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
          following: msg.following === true,
        },
        stream?.sink,
      );
      log(`handled user=${msg.userId} channel=${msg.channelId} kind=${result.kind}`);
      if (result.kind === "ignored") {
        // Queued, dropped, or not for us. Returning here used to leave the
        // armed "thinking" timer to fire a few seconds later into a turn that
        // no longer existed - which is where a busy thread collected a row of
        // placeholder cards that never completed.
        const { emptyTs } = (await stream?.abandon()) ?? {};
        if (emptyTs) await deps.slack?.remove(msg.channelId, emptyTs).catch(() => undefined);
        return;
      }

      // If the reply streamed successfully, Slack already has it; otherwise post.
      // An empty reply means the command already delivered itself into the thread
      // (e.g. review posts progress + result directly), so post nothing more.
      // Always finish, started or not: an unfired placeholder timer is still
      // armed, and only finishing cancels it.
      const streamed = stream ? await stream.finish() : false;
      const broadcast = shouldBroadcast(msg);
      if (streamed) {
        // chat.startStream takes no reply_broadcast, so promote the finished
        // message instead. Sending no content leaves the streamed blocks intact.
        if (broadcast && stream?.ts) {
          await msg.client.chat
            .update({ channel: msg.channelId, ts: stream.ts, reply_broadcast: true })
            .catch((e: unknown) => log(`broadcast failed: ${e instanceof Error ? e.message : String(e)}`));
        }
        // The work is done, so the column of tool cards above the answer is
        // just something to scroll past. Replace it with one line, keeping any
        // step that FAILED - that is the part somebody may have to act on.
        // Watching the cards arrive is how anyone knows the turn is alive, so
        // this only ever happens after it has finished.
        const collapsed = stream?.ts ? collapseSteps(stream.steps) : undefined;
        if (collapsed && stream?.ts) {
          const body = toMrkdwn(result.text);
          const rich = toBlockMessage(result.text, toMrkdwn);
          const blocks = rich?.blocks
            ? [...rich.blocks, ...collapsedBlocks("", collapsed)]
            : collapsedBlocks(body, collapsed);
          await msg.client.chat
            .update({ channel: msg.channelId, ts: stream.ts, text: body, blocks })
            // A tidy-up that fails must leave the answer exactly as it was.
            .catch((e: unknown) => log(`collapse failed: ${e instanceof Error ? e.message : String(e)}`));
        }
      } else if (result.text.trim() && !isSilenceNote(result.text)) {
        // Converted at the boundary, not merely asked for in the prompt: a rule
        // the model may ignore is not a guarantee, and what it ignores is the
        // one thing the reader sees.
        // A reply carrying a ```blockkit fence posts as blocks, its prose in
        // markdown blocks around them; anything else stays a plain text post.
        // Blocks Slack refuses (`invalid_blocks`) fall back to the plain post.
        const rich = toBlockMessage(result.text, toMrkdwn);
        const extra = { thread_ts: msg.threadTs, ...(broadcast ? { reply_broadcast: true } : {}) };
        const plain = () => msg.say({ text: toMrkdwn(result.text), ...extra });
        if (rich) await msg.say({ ...rich, ...extra }).catch(plain);
        else await plain();
      }
    } catch (err) {
      log(`respond failed: ${err instanceof Error ? err.message : String(err)}`);
      // Not `started`: an armed-but-unfired placeholder is the exact case that
      // leaves a stray card behind, and only finishing cancels its timer.
      if (stream) await stream.finish().catch(() => undefined);
      // A turn reaped for running long is not a bug, and saying "I hit an error"
      // invites the same question again rather than a narrower one.
      const text = isTimeout(err)
        ? "that one ran past my time limit for a single turn, so I lost it. it usually means I was digging through a lot - ask me again with a narrower scope, or run it as a `workflow` which has no such limit"
        : "Sorry, I hit an error handling that. Please try again in a moment.";
      await msg
        .say({ text, thread_ts: msg.threadTs })
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
            reply: deps.slack ? async (text: string) => void (await deps.slack!.post(channelId, text, threadTs)) : undefined,
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
          reply: deps.slack ? async (text: string) => void (await deps.slack!.post(channel, text, req.threadTs)) : undefined,
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

  /**
   * The command menu: a pick runs the command, or asks for its arguments first.
   *
   * It runs as whoever pressed it, through the ordinary dispatcher, so the
   * command's own role gate still decides. A button is never a way to run
   * something you could not have typed.
   */
  const menuModal = (command: string, usage: string, summary: string, metadata: string, confirmOnly = false) => ({
    type: "modal" as const,
    callback_id: MENU_VIEW,
    private_metadata: metadata,
    title: { type: "plain_text" as const, text: clip(command, 24) },
    submit: { type: "plain_text" as const, text: confirmOnly ? "Yes, do it" : "Run" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks: confirmOnly
      ? [{ type: "section", text: { type: "mrkdwn", text: `*${command}* - ${summary}.\n\nThis cannot be undone.` } }]
      : [
          {
            type: "input",
            block_id: MENU_BLOCK,
            label: { type: "plain_text", text: clip(usage || "arguments", 48) },
            hint: { type: "plain_text", text: clip(summary, 150) },
            element: {
              type: "plain_text_input",
              action_id: MENU_INPUT,
              placeholder: { type: "plain_text", text: clip(usage || "…", 150) },
            },
          },
        ],
  });

  /** Run a command on behalf of whoever pressed, answering where they pressed. */
  const runFromMenu = async (by: string, channelId: string, threadTs: string | undefined, line: string) => {
    const user = deps.users.get(by);
    if (!user) return;
    const reply = async (text: string) => {
      await deps.slack?.post(channelId, text, threadTs);
    };
    try {
      const text = await dispatchCommand(deps, user, channelId, line, {
        prefix: deps.commandPrefix,
        slash: deps.slashCommand,
        threadTs,
        reply,
      });
      if (text.trim()) await reply(text);
    } catch (err) {
      log(`menu command failed: ${err instanceof Error ? err.message : String(err)}`);
      await reply("that one did not go through - try typing it").catch(() => undefined);
    }
  };

  const onMenuPress = async ({ ack, body, action, client }: MenuArgs) => {
    await ack();
    const by = body.user?.id;
    const channelId = body.channel?.id;
    const command = action.selected_option?.value ?? action.value;
    if (!by || !channelId || !command) return;
    // Answer under the menu rather than beside it: the menu is often posted at
    // the top of a channel, and a thread keeps the reply with the question.
    const threadTs = body.message?.thread_ts ?? body.message?.ts;

    const info = listCommandInfo().find((c) => c.name === command);
    // Arguments, or a destructive command that should be asked about first.
    const wantsArgs = !!info && needsArguments(info.usage);
    if (info && (wantsArgs || info.destructive) && body.trigger_id) {
      try {
        await client.views.open({
          trigger_id: body.trigger_id,
          view: menuModal(
            command,
            info.usage,
            info.summary,
            encodeMenuRequest({ channelId, threadTs, command }),
            !wantsArgs,
          ) as never,
        });
      } catch (err) {
        log(`menu modal failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    await runFromMenu(by, channelId, threadTs, command);
  };
  app.action({ action_id: MENU_SELECT_ACTION }, onMenuPress as never);
  // One id per button, so they are matched by prefix rather than by name.
  app.action(MENU_RUN_PATTERN, onMenuPress as never);

  app.view(MENU_VIEW, (async ({ ack, body, view }: ViewArgs) => {
    await ack();
    const req = decodeMenuRequest(view.private_metadata);
    const by = body.user?.id;
    if (!req?.command || !by) return;
    const args = view.state?.values?.[MENU_BLOCK]?.[MENU_INPUT]?.value ?? "";
    await runFromMenu(by, req.channelId, req.threadTs, `${req.command} ${args}`.trim());
  }) as never);


  /**
   * Slack's OWN stop button, on an agent session.
   *
   * Subscribing to this event is what makes that button interactive at all -
   * without the subscription Slack draws a loading indicator nobody can press,
   * which looks like a control and does nothing. Two things are owed on a
   * press, and the second is the one easy to miss: stop the work, and close
   * the streams Slack names, or the session sits in `processing` with no way
   * out. The streams are closed either way, because a press with nothing left
   * running still has to leave that state.
   */
  app.event(AGENT_SESSION_STOPPED as never, (async ({ event, client }: { event: unknown; client: unknown }) => {
    const plan = planSessionStop(event as AgentSessionStoppedEvent);
    if (plan.kind === "ignored") {
      log(`agent session stop ignored: ${plan.why}`);
      return;
    }

    const stopped = deps.runs?.stopThread(plan.key, plan.by);

    const api = client as { apiCall: (method: string, args: Record<string, unknown>) => Promise<unknown> };
    let closed = 0;
    for (const ts of plan.streams) {
      try {
        await api.apiCall("chat.stopStream", { channel: plan.channel, ts });
        closed += 1;
      } catch (err) {
        log(`stopStream failed for ${ts}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Only when something was actually stopped. Telling a thread "nothing was
    // running" right after somebody tapped stop is noise - Slack's own UI has
    // already shown them it stopped.
    if (stopped) {
      await deps.slack
        ?.post(plan.channel, sessionStoppedNotice(stopped, plan.by, Date.now(), forHowLong), plan.threadTs)
        .catch(() => undefined);
    }
    log(
      `agent session stop by ${plan.by}: ${stopped ? `stopped ${stopped.id}` : "nothing running"}, ${closed}/${plan.streams.length} streams closed`,
    );
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
  /**
   * Who wrote a thread's parent, and who has written in it, cached per thread.
   *
   * One lookup answers both: the parent message carries `reply_users`. The
   * author cannot change, but the participants can, so an entry only lives
   * for a short while - long enough that a busy thread does not spend a Slack
   * call on every line, short enough that a second person joining ends a
   * one-on-one within seconds.
   */
  type ThreadInfo = { author?: string; participants: string[]; at: number };
  const threadInfos = new Map<string, ThreadInfo>();
  const THREAD_INFO_TTL_MS = 30_000;
  const threadInfo = async (client: SlackClient, channel: string, threadTs: string): Promise<ThreadInfo> => {
    const key = `${channel}:${threadTs}`;
    const cached = threadInfos.get(key);
    if (cached && Date.now() - cached.at < THREAD_INFO_TTL_MS) return cached;
    let info: ThreadInfo = { participants: [], at: Date.now() };
    try {
      const res = (await (client as unknown as {
        conversations: {
          replies: (a: unknown) => Promise<{ messages?: { user?: string; reply_users?: string[] }[] }>;
        };
      }).conversations.replies({ channel, ts: threadTs, limit: 1 })) ?? {};
      const parent = res.messages?.[0];
      const participants = [...(parent?.user ? [parent.user] : []), ...(parent?.reply_users ?? [])];
      info = { author: parent?.user, participants, at: Date.now() };
    } catch (err) {
      // Cannot see the thread: treat it as not ours and stay quiet, but say
      // so - a lookup that fails reads exactly like a thread that is not ours.
      log(`thread lookup failed channel=${channel} thread=${threadTs}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Cached either way, including the failure - retrying on every message in
    // a thread we cannot read is a loop, not a recovery.
    threadInfos.delete(key);
    threadInfos.set(key, info);
    if (threadInfos.size > 500) {
      const oldest = threadInfos.keys().next().value;
      if (oldest) threadInfos.delete(oldest);
    }
    return info;
  };

  app.message(async ({ message, client, say, context }) => {
    const m = message as RawMessage & { channel: string; ts: string };
    if (!shouldHandleDm(m)) {
      // Three ways a thread is one it keeps up with, tag or no tag. It OPENED
      // this one - it started the conversation, so it is expected to follow
      // it. Or somebody ASKED it to, with `follow`, which is how a thread
      // started by a person gets the same treatment. Or it is just it and
      // one person talking, who should not have to tag it on every line.
      const me = await deps.slack?.botUserId().catch(() => undefined);
      if (!couldFollowThread(m, me)) return;
      if (!me) {
        log(`follow skip channel=${m.channel} thread=${m.thread_ts} user=${m.user}: bot id unknown`);
        return;
      }
      const asked = deps.follows?.isFollowed(m.channel, m.thread_ts!) === true;
      const ownThreadsOff =
        deps.settings?.get("follow_own_threads")?.trim().toLowerCase() === "off";
      // Only look the thread up when the answer could still depend on it: the
      // lookup is a Slack call, and an explicit follow already settles it. A
      // thread that is just it and one person is followed too, setting or not.
      const info = asked ? undefined : await threadInfo(asClient(client), m.channel, m.thread_ts!);
      const ownThread = !!info && !ownThreadsOff && info.author === me;
      const oneOnOne =
        !!info && isOneOnOneThread({ participants: info.participants, author: m.user!, botUserId: me });
      // Every human reply in a thread gets one line, follow or not. So a reply
      // with NO line here never reached the bot at all - Slack did not deliver
      // the event - and that is a different fix from a decision that said no.
      const verdict = followVerdict({ asked, ownThread, ownThreadsOff, oneOnOne });
      log(
        `follow ${verdict.follow ? "yes" : "skip"} channel=${m.channel} (${m.channel_type ?? "?"}) ` +
          `thread=${m.thread_ts} user=${m.user}: ${verdict.why}` +
          (info ? ` author=${info.author ?? "?"} participants=${info.participants.join(",") || "none"}` : ""),
      );
      if (!verdict.follow) return;
      await handle({
        channelId: m.channel,
        userId: m.user!,
        teamId: context.teamId,
        text: m.text!,
        threadTs: threadKeyOf(m),
        messageTs: m.ts,
        client: asClient(client),
        following: true,
        say: say as Incoming["say"],
      });
      return;
    }
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
