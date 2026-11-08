/**
 * Core chat use case: an allowed user says something, the bot replies in character
 * and both turns are remembered.
 *
 * All I/O is injected, so this reads as a straight line of business logic and is
 * covered by fast, deterministic tests.
 */
import { decideAccess } from "../domain/access.ts";
import { disabledRoleReason } from "../domain/rolePolicy.ts";
import {
  buildContextWindow,
  cleanInboundText,
  ATTACHMENT_MARKER,
  DEFAULT_CONTEXT_WINDOW,
  endAtTrigger,
  reactableMessages,
} from "../domain/conversation.ts";
import { buildSystemPrompt, buildSystemPromptParts } from "../domain/personality.ts";
import type { PromptGuide } from "../domain/promptGuides.ts";
import { adapterRules } from "../domain/adapter.ts";
import { hasContent } from "../domain/mentions.ts";
import type { Clock, LlmPort, LlmStreamSink } from "./ports.ts";
import type { PromptContext, StoredMessage, UserRole } from "../domain/types.ts";
import type { ToolPolicy } from "../domain/toolPolicy.ts";
import type { MessageRepo } from "../infrastructure/db/messageRepo.ts";
import type { UserRepo } from "../infrastructure/db/userRepo.ts";
import type { LearningsRepo } from "../infrastructure/db/learningsRepo.ts";
import type { AdapterStore } from "../infrastructure/adapter/adapterStore.ts";
import type { SystemTracker } from "../infrastructure/system/systemProbe.ts";
import type { AdapterRevisionRepo } from "../infrastructure/db/adapterRevisionRepo.ts";
import type { CommandLogRepo } from "../infrastructure/db/commandLogRepo.ts";
import type { UsageRepo } from "../infrastructure/db/usageRepo.ts";
import type { TurnLogRepo } from "../infrastructure/db/turnLogRepo.ts";
import type { ReminderRepo } from "../infrastructure/db/reminderRepo.ts";
import type { WatchRepo } from "../infrastructure/db/watchRepo.ts";
import type { FollowRepo } from "../infrastructure/db/followRepo.ts";
import type { WorkflowRepo } from "../infrastructure/db/workflowRepo.ts";
import type { AccessRequestRepo } from "../infrastructure/db/accessRequestRepo.ts";
import type { CommandApprovalRepo } from "../infrastructure/db/commandApprovalRepo.ts";
import type { SettingsRepo } from "../infrastructure/db/settingsRepo.ts";
import { requestAccess } from "./accessRequests.ts";
import type { CommandTickets } from "./commandTickets.ts";
import { tokenFor, type ClaudeTokenPort } from "./claudeTokens.ts";
import type { TotpPort } from "./totp.ts";
import { isMissingSession, threadSessionName, tierOf, unseenTurns } from "../domain/threadSession.ts";
import { promptFingerprint } from "../domain/promptFingerprint.ts";
import type { ThreadSessionRepo } from "../infrastructure/db/threadSessionRepo.ts";
import type { SlackAdminPort, SlackMessage } from "./slackAdmin.ts";
import type { GitHubPort } from "./github.ts";
import type { DraftReply } from "./draftReply.ts";

export type HandleMessageDeps = {
  users: UserRepo;
  messages: MessageRepo;
  llm: LlmPort;
  clock: Clock;
  ownerSlackId: string;
  contextWindow?: number;
  /** Supplies the editable base prompt + learnings; defaults to the built-in personality. */
  promptContext?: () => PromptContext;
  /** Learnings repo, for the `learn`/`learnings` commands. */
  learnings?: LearningsRepo;
  /** The memory adapter, for the `adapter` command; replaces `learnings`. */
  adapterStore?: AdapterStore;
  adapterRevisions?: AdapterRevisionRepo;
  adapterBudget?: () => number;
  /** Host and process vitals, for the `sys` command. */
  system?: SystemTracker;
  /** Commands one turn may run, so the brain can plan rather than discover it. */
  commandBudget?: () => number;
  /** Bot name + model, for the `model`/`status` command. */
  botInfo?: () => { botName: string; model: string };
  /** Audit log for command executions. */
  commandLog?: CommandLogRepo;
  /** What each run of the model consumed, for `spend` and the dashboard. */
  usage?: UsageRepo;
  /** How each turn ended, for `mindful` and for continuing a failed thread. */
  turns?: TurnLogRepo;
  /** Things the bot is waiting for, so a turn knows it can set one. */
  watches?: WatchRepo;
  /** Threads it was asked to keep up with, tag or no tag. */
  follows?: FollowRepo;
  /** Reminders people asked for, for the `remind` command. */
  reminders?: ReminderRepo;
  /** The workspace domain, so `mindful` can print clickable thread links. */
  slackTeam?: () => string | undefined;
  /** Run a chat turn in a thread from outside the Slack handler (`mindful`). */
  runTurn?: (req: {
    channelId: string;
    threadTs: string;
    slackUserId: string;
    text: string;
    keepSession?: boolean;
    /** A workflow step the bot started itself, not a human message. */
    autoContinue?: boolean;
  }) => Promise<void>;
  /** Timer for a workflow's next step; injected so tests need not wait. */
  continueTimer?: (fn: () => void, ms: number) => void;
  /** Set of disabled command names (managed from the dashboard). */
  disabledCommands?: () => ReadonlySet<string>;
  /** Commands each role's dashboard policy denies (see `CommandDeps`). */
  deniedCommands?: (role: UserRole) => ReadonlySet<string>;
  /**
   * The role an allowlisted person holds when that role is switched off. They
   * are told so in one line rather than raised to the owner as a stranger.
   */
  roleDisabled?: (slackId: string) => UserRole | undefined;
  /** Slack Web API operations, for the power-tool commands (br, jrp). */
  slack?: SlackAdminPort;
  /** GitHub actions the bot takes itself - the up-front approve in `review`. */
  github?: GitHubPort;
  /** AI reply drafting, for jrp. */
  draft?: DraftReply;
  /** Per-role CLI tool policy (sandbox/allow-list) applied to the chat brain. */
  toolPolicy?: (role: UserRole, channelId?: string) => ToolPolicy;
  /** Per-user Claude Code tokens: a speaker's own turns run on their credential. */
  claudeTokens?: ClaudeTokenPort;
  /** Shared 2FA setup keys, for the `2fa` command. */
  totp?: TotpPort;
  /** One CLI session per thread, so a follow-up costs a follow-up. */
  threadSessions?: ThreadSessionRepo;
  /** Whether thread sessions are switched on. Read per turn, so it needs no restart. */
  threadSessionsOn?: () => boolean;
  /** Absolute path of the reaction helper, granted to every role. */
  reactScript?: string;
  /**
   * Where the how-to guides are written. Set, a turn that can read files gets
   * the procedure blocks as files it reads on demand rather than inlined.
   */
  guideDir?: string;
  /** Writes the guides a prompt points at, before the turn that reads them. */
  writeGuides?: (dir: string, guides: readonly PromptGuide[]) => void;
  /** Absolute path of the Slack file downloader, granted to every role. */
  fileScript?: string;
  /** Absolute path of the read-only Grafana helper, granted to every role. */
  grafanaGetScript?: string;
  /** Absolute path of the read-only Slack reader, granted to every role. */
  slackReadScript?: string;
  /** Absolute path of the "has anything new been said" helper, for `watch reply`. */
  slackWaitScript?: string;
  /** Absolute path of the desktop driver (`bin/mac-ui.js`). */
  macUiScript?: string;
  /** Absolute path of the agent-desktop binary, when it is installed. */
  agentDesktop?: string;
  /** Absolute path of `bin/desktop.ts`, which runs either driver under a desktop-wide lock. */
  desktopScript?: string;
  /** Absolute path of the claude.ai artifact reader. */
  artifactScript?: string;
  /** Absolute path of the verify-and-restart helper. Admin+ only; see below. */
  restartScript?: string;
  /** The bot's own source tree, so it can work on itself. Admin+ only. */
  repoPath?: string;
  /** Long-running workflow sessions bound to a thread. */
  workflows?: WorkflowRepo;
  /** Pending access requests, so a stranger is put to the owner rather than refused. */
  accessRequests?: AccessRequestRepo;
  /** Commands parked for approval once a limited role runs out of allowance. */
  commandApprovals?: CommandApprovalRepo;
  /** Settings, for per-person command allowances. */
  settings?: SettingsRepo;
  /** Observability backends in preference order; empty means none configured. */
  logSources?: () => readonly string[];
  /** Whether a ticket tracker is configured, so chat bug reports can be raised. */
  canRaiseTickets?: () => boolean;
  /** Fresh CLI session id for a workflow or a thread session; injected for tests. */
  newSessionId?: () => string;
  /** Local endpoint the bot can POST a learning to, if the listener may teach. */
  learnUrl?: string;
  /** Local endpoint the bot can POST a command to. */
  runUrl?: string;
  /** Local endpoint the bot stores a modal at, for a `jv:modal:` button to open. */
  kitUrl?: string;
  /** Absolute path of the command helper, granted to every role. */
  runScript?: string;
  /** Mints the per-turn ticket that decides who a triggered command runs as. */
  commandTickets?: CommandTickets;
  /** Configured message command prefix + slash name, for the command layer. */
  commandPrefix?: string;
  slashCommand?: string;
};

/** Author id recorded for the bot's own turns (never a real Slack id). */
export const ASSISTANT_AUTHOR = "assistant";

export type InboundMessage = {
  channelId: string;
  slackUserId: string;
  text: string;
  /** best-effort display name from Slack, used to keep the allowlist fresh */
  displayName?: string;
  /** thread to reply into (message commands); absent for a top-level DM */
  threadTs?: string;
  /** Slack ts of this very message, so it can later be reacted to */
  messageTs?: string;
  /** true when the command came in via a Slack slash command, not a message */
  viaSlash?: boolean;
  /** An untagged reply under a thread the bot started; nobody asked it. */
  following?: boolean;
  /** A retry: a restart cut the first attempt at this message off part way. */
  interrupted?: boolean;
  /**
   * Resume the thread's session even if it was opened under older rules.
   * A watch handing a thread back is finishing work that session started -
   * the build it kicked off, the PR it opened - and a restart to ship a new
   * feature changes the rules, so the ordinary "abandon a stale session" rule
   * would hand the job to a cold turn that never saw any of it.
   */
  keepSession?: boolean;
  /**
   * A workflow step the bot queued itself after a turn ended with
   * `[continue]`. It only ever drives a live workflow: with none in the
   * thread it is dropped rather than handed to the chat brain.
   */
  autoContinue?: boolean;
  /**
   * Started by the bot itself, not typed by anyone: a watch handing the
   * thread back. It still queues behind a running turn, but nobody is waiting
   * on its place in line, so it posts no "yours is next" notice.
   */
  unprompted?: boolean;
};

export type HandleResult =
  | { kind: "reply"; text: string }
  | { kind: "denied"; text: string }
  | { kind: "ignored" };

export const handleMessage = async (
  deps: HandleMessageDeps,
  inbound: InboundMessage,
  sink?: LlmStreamSink,
  /** Ends the turn when aborted, so a long one can be stopped. */
  signal?: AbortSignal,
): Promise<HandleResult> => {
  const text = cleanInboundText(inbound.text);
  if (!hasContent(text)) return { kind: "ignored" };

  const decision = decideAccess(inbound.slackUserId, deps.ownerSlackId, deps.users.get);
  if (!decision.allowed) {
    // Following a thread, nobody asked: a stranger chatting there is not a
    // request, and answering each of them is just noise.
    if (inbound.following) return { kind: "ignored" };
    // On the list, but their role is switched off: say so, do not ask the owner
    // to let in someone the owner already chose to shut out.
    const off = deps.roleDisabled?.(inbound.slackUserId);
    if (off) return { kind: "denied", text: disabledRoleReason(off) };
    // Ask the owner rather than turning them away.
    const asked = await requestAccess(
      deps,
      {
        slackUserId: inbound.slackUserId,
        displayName: inbound.displayName,
        channelId: inbound.channelId,
        threadTs: inbound.threadTs,
        text,
      },
      decision.reason,
    );
    return asked === undefined ? { kind: "ignored" } : { kind: "denied", text: asked };
  }

  // Keep the allowlist's view of who this is current (owner is auto-provisioned).
  ensureUserRecord(deps, decision.user.slackId, decision.user.role, inbound.displayName);

  const now = deps.clock();
  deps.messages.append(
    {
      channelId: inbound.channelId,
      slackUserId: inbound.slackUserId,
      role: "user",
      content: text,
      ...(inbound.messageTs ? { slackTs: inbound.messageTs } : {}),
      threadTs: inbound.threadTs ?? "",
    },
    now,
  );

  // Its own id, so a mention of itself is recognised as itself.
  const botUserId = await deps.slack?.botUserId().catch(() => undefined);
  // Minted once for this turn. It reaches the CLI through its environment, not
  // its prompt: a thread's session remembers every prompt it was ever handed,
  // and a remembered ticket is both dead and somebody else's.
  const runTicket = deps.commandTickets?.issue({
    actor: decision.user.slackId,
    channel: inbound.channelId,
    threadTs: inbound.threadTs,
  });
  const window = deps.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  // The thread itself is the context, read from Slack: the whole of this thread
  // and nothing from the ones beside it. Stored memory is only the fallback -
  // it holds just the turns the bot handled, so anything said while it was not
  // listening (or before it joined) is missing from it.
  const history =
    (await loadThread(deps, inbound)) ??
    deps.messages.recentForThread(inbound.channelId, inbound.threadTs ?? "", window);
  const ctx = deps.promptContext?.() ?? { learnings: [] };
  const participants = collectParticipants(deps, history, inbound);
  // Needed before the prompt is built: a sandboxed turn cannot read the
  // adapter's files, so it must not be offered skills it could never open.
  const policy = deps.toolPolicy?.(decision.user.role, inbound.channelId);
  const promptOptions: Parameters<typeof buildSystemPromptParts>[0] = {
    botName: ctx.botName,
    base: ctx.base,
    learnings: ctx.learnings,
    addresseeName: inbound.displayName ?? decision.user.displayName,
    participants,
    // Lets the bot react to earlier messages with its own token, if it wants to.
    channelId: inbound.channelId,
    reactable: reactableMessages(history),
    reactScript: deps.reactScript,
    fileScript: deps.fileScript,
    botUserId,
    logSources: deps.logSources?.(),
    canRaiseTickets: deps.canRaiseTickets?.(),
    grafanaGetScript: deps.grafanaGetScript,
    slackReadScript: deps.slackReadScript,
    // It drives the real screen somebody is sitting at, so it is offered only
    // to the roles whose tool policy grants it: full access, and executers for
    // browser testing.
    macUiScript: canDrive(decision.user.role) ? deps.macUiScript : undefined,
    agentDesktop: canDrive(decision.user.role) ? deps.agentDesktop : undefined,
    desktopScript: canDrive(decision.user.role) ? deps.desktopScript : undefined,
    // ... and keep a durable fact, but only when talking to someone who could
    // have taught it one by hand. Learnings apply to everyone, everywhere.
    learnUrl: canTeach(decision.user.role) ? deps.learnUrl : undefined,
    // Working on its own source is admin+, and not as a formality: a bad change
    // restarted into is a crash-loop that cannot be fixed from Slack.
    repoPath: canTeach(decision.user.role) ? deps.repoPath : undefined,
    restartScript: canTeach(decision.user.role) ? deps.restartScript : undefined,
    // Offered to everyone: the command's own role gate decides what actually
    // runs, so asking in words can never do more than typing it would.
    runUrl: deps.runUrl,
    runScript: deps.runScript,
    // Offered to everyone too: a press runs as whoever pressed it, under
    // their own role, so a button can do no more than typing would.
    kitUrl: deps.kitUrl,
    runTicket,
    commandBudget: deps.commandBudget?.(),
    // A watch belongs to a thread it can come back to, and setting one needs
    // the role that `watch` is gated on - offering it to anyone else would be
    // describing a door that is locked.
    canWatch: !!deps.watches && !!inbound.threadTs && canTeach(decision.user.role),
    following: inbound.following === true,
    interrupted: inbound.interrupted === true,
    commandPrefix: deps.commandPrefix,
    adapter: ctx.adapter,
    // Scoped memory resolves against who is actually here and where.
    adapterScope: {
      channelId: inbound.channelId,
      participantIds: participants.map((p) => p.id),
      canReadFiles: tierOf(policy) === "full",
    },
    // Only with somewhere to write them: a guide the turn cannot open is a
    // rule it never sees.
    guideDir: deps.writeGuides ? deps.guideDir : undefined,
  };
  const built = buildSystemPromptParts(promptOptions);
  // The prompt names the guide files, so they must exist before it runs. A
  // failed write falls back to the inlined prompt rather than pointing at
  // files that are not there.
  let system = built.prompt;
  if (built.guides.length > 0 && deps.guideDir && deps.writeGuides) {
    try {
      deps.writeGuides(deps.guideDir, built.guides);
    } catch {
      system = buildSystemPromptParts({ ...promptOptions, guideDir: undefined }).prompt;
    }
  }

  // One CLI session per thread, per access tier: the model keeps its own context
  // between turns, so it is handed only what it has not seen rather than the
  // whole thread replayed into a memory that already holds it.
  const tier = tierOf(policy);
  const sessions = deps.threadSessionsOn?.() === false ? undefined : deps.threadSessions;
  const key = sessions && inbound.threadTs ? { channelId: inbound.channelId, threadTs: inbound.threadTs } : undefined;
  // A session opened under different rules is abandoned: it carries everything
  // it has already said, so a rule change would otherwise never reach a thread
  // that was already running.
  const fingerprint = promptFingerprint(
    buildSystemPrompt as never,
    ctx.base,
    ctx.adapter ? adapterRules(ctx.adapter) : undefined,
  );
  const found = key ? sessions?.find(key.channelId, key.threadTs, tier) : undefined;
  const stale = !!found?.promptHash && found.promptHash !== fingerprint;
  // A hand-back keeps the stale session for its own turn only and leaves the
  // old fingerprint in place, so the next ordinary turn still picks up the
  // new rules.
  if (found && stale && key && !inbound.keepSession) {
    sessions?.drop(key.channelId, key.threadTs, tier);
  }
  const bound = found && (!stale || inbound.keepSession) ? found : undefined;
  const cold = () => buildContextWindow(history, window);
  const newestTs = history[history.length - 1]?.slackTs ?? inbound.messageTs ?? "";

  const base = {
    system,
    assistantName: ctx.botName,
    policy,
    // Their own credential when they have registered one, so the turn is theirs
    // in every sense; the bot's own when they have not.
    oauthToken: tokenFor(deps, decision.user),
    signal,
    runTicket,
    // Whose turn this is, so what it consumed lands against them.
    bill: {
      actor: decision.user.slackId,
      kind: "chat",
      channel: inbound.channelId,
      threadTs: inbound.threadTs ?? inbound.messageTs,
    },
  };
  const run = (p: Parameters<typeof deps.llm.complete>[0]) =>
    sink && deps.llm.stream ? deps.llm.stream(p, sink) : deps.llm.complete(p);

  // Named after the thread, so another thread's session can find this one.
  const name = key ? threadSessionName(key.channelId, key.threadTs) : undefined;
  let sessionId = bound?.sessionId ?? deps.newSessionId?.() ?? crypto.randomUUID();
  let resumed = !!bound;
  // Bind BEFORE the run, not after. A turn that dies - and a turn that dies is
  // usually the long, expensive one - would otherwise leave nothing bound, so
  // the retry starts cold and repeats the same expensive discovery that ran it
  // out of time in the first place. The CLI writes its session as it goes, so
  // resuming a killed one picks up everything it had already done.
  if (key && !bound) sessions?.claim(key.channelId, key.threadTs, tier, sessionId, newestTs, deps.clock(), fingerprint);
  let raw: string;
  try {
    raw = await run({
      ...base,
      messages: bound ? buildContextWindow(unseenTurns(history, bound.lastTs), window) : cold(),
      ...(key ? { session: { id: sessionId, resume: resumed, name } } : {}),
    });
  } catch (err) {
    // The CLI prunes its own history and a database outlives the machine it was
    // written on, so a session that will not resume is expected, not an error to
    // put in front of anyone: start a new one and hand it the thread cold.
    if (!bound || !isMissingSession(err)) throw err;
    sessionId = deps.newSessionId?.() ?? crypto.randomUUID();
    resumed = false;
    if (key) sessions?.claim(key.channelId, key.threadTs, tier, sessionId, newestTs, deps.clock(), fingerprint);
    raw = await run({ ...base, messages: cold(), session: { id: sessionId, resume: false, name } });
  }
  const reply = raw.trim();

  // Already bound above; this only records that the turn landed and how far the
  // session has now been shown.
  if (key) sessions?.touch(key.channelId, key.threadTs, tier, newestTs, deps.clock());

  const safeReply = reply.length > 0 ? reply : "I do not have anything useful to add there.";

  deps.messages.append(
    {
      channelId: inbound.channelId,
      // The bot authored this turn, not the human who prompted it.
      slackUserId: ASSISTANT_AUTHOR,
      role: "assistant",
      content: safeReply,
      threadTs: inbound.threadTs ?? "",
    },
    deps.clock(),
  );

  return { kind: "reply", text: safeReply };
};

/**
 * Read this thread out of Slack, shaped like stored turns so everything
 * downstream is unchanged.
 *
 * Only this thread: `conversations.replies` is scoped to one root, so the
 * neighbouring conversations in the same channel never come along. Returns
 * undefined when there is nothing to read or the call fails (missing scope, a
 * rate limit), and the caller falls back to stored memory.
 */
const loadThread = async (
  deps: HandleMessageDeps,
  inbound: InboundMessage,
): Promise<StoredMessage[] | undefined> => {
  if (!deps.slack || !inbound.threadTs) return undefined;
  let thread: readonly SlackMessage[];
  try {
    thread = await deps.slack.replies(inbound.channelId, inbound.threadTs);
  } catch {
    return undefined; // no scope / API trouble - stored memory still works
  }
  if (thread.length === 0) return undefined;

  const read = thread
    .filter((m) => m.text.trim().length > 0 || (m.files?.length ?? 0) > 0)
    .map((m, i) => ({
      id: i,
      channelId: inbound.channelId,
      slackUserId: m.own ? ASSISTANT_AUTHOR : m.userId,
      role: (m.own ? "assistant" : "user") as StoredMessage["role"],
      content: withAttachments(m),
      createdAt: Math.round(Number(m.ts) * 1000) || 0,
      slackTs: m.ts,
      threadTs: inbound.threadTs,
    }));
  const turns = endAtTrigger(read, inbound.messageTs);

  // Slack can lag a beat on the message that triggered us; it has to be last.
  if (!turns.some((t) => t.slackTs === inbound.messageTs)) {
    turns.push({
      id: turns.length,
      channelId: inbound.channelId,
      slackUserId: inbound.slackUserId,
      role: "user",
      content: cleanInboundText(inbound.text),
      createdAt: deps.clock(),
      slackTs: inbound.messageTs ?? "",
      threadTs: inbound.threadTs,
    });
  }
  return turns;
};

/**
 * A turn as the model should see it: its text, plus anything attached.
 *
 * An attachment is invisible in `text`, so without this the model cannot know a
 * screenshot or a document was ever shared - let alone open it.
 */
const withAttachments = (m: SlackMessage): string => {
  const text = m.text.trim();
  if (!m.files || m.files.length === 0) return text;
  const attached = m.files
    .map((f) => `- ${f.name} (${f.mimetype})${f.urlPrivate ? ` ${f.urlPrivate}` : ""}`)
    .join("\n");
  return `${text}${text ? "\n" : ""}${ATTACHMENT_MARKER}\n${attached}`;
};

/** Roles allowed to teach the bot - the same gate the `learn` command applies. */
const canTeach = (role: UserRole): boolean => role === "admin" || role === "owner";
const canDrive = (role: UserRole): boolean => canTeach(role) || role === "executer";

/** Distinct people who have spoken in this channel, resolved to names we know. */
const collectParticipants = (
  deps: HandleMessageDeps,
  history: readonly { role: "user" | "assistant"; slackUserId: string }[],
  inbound: InboundMessage,
) => {
  const ids = new Set<string>();
  for (const m of history) if (m.role === "user") ids.add(m.slackUserId);
  ids.add(inbound.slackUserId);
  return [...ids].map((id) => {
    const name =
      deps.users.get(id)?.displayName ||
      (id === inbound.slackUserId ? inbound.displayName : undefined) ||
      undefined;
    return { id, name };
  });
};

const ensureUserRecord = (
  deps: HandleMessageDeps,
  slackId: string,
  role: UserRole,
  displayName?: string,
): void => {
  const existing = deps.users.get(slackId);
  if (!existing) {
    deps.users.upsert({
      slackId,
      role,
      displayName: displayName ?? "",
      addedBy: "system",
      createdAt: deps.clock(),
    });
    return;
  }
  if (displayName && displayName !== existing.displayName) {
    deps.users.setDisplayName(slackId, displayName);
  }
};
