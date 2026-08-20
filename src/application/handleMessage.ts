/**
 * Core chat use case: an allowed user says something, the bot replies in character
 * and both turns are remembered.
 *
 * All I/O is injected, so this reads as a straight line of business logic and is
 * covered by fast, deterministic tests.
 */
import { decideAccess } from "../domain/access.ts";
import {
  buildContextWindow,
  cleanInboundText,
  DEFAULT_CONTEXT_WINDOW,
} from "../domain/conversation.ts";
import { buildSystemPrompt } from "../domain/personality.ts";
import { hasContent } from "../domain/mentions.ts";
import type { Clock, LlmPort, LlmStreamSink } from "./ports.ts";
import type { PromptContext, UserRole } from "../domain/types.ts";
import type { ToolPolicy } from "../domain/toolPolicy.ts";
import type { MessageRepo } from "../infrastructure/db/messageRepo.ts";
import type { UserRepo } from "../infrastructure/db/userRepo.ts";
import type { LearningsRepo } from "../infrastructure/db/learningsRepo.ts";
import type { CommandLogRepo } from "../infrastructure/db/commandLogRepo.ts";
import type { SlackAdminPort } from "./slackAdmin.ts";
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
  /** Bot name + model, for the `model`/`status` command. */
  botInfo?: () => { botName: string; model: string };
  /** Audit log for command executions. */
  commandLog?: CommandLogRepo;
  /** Set of disabled command names (managed from the dashboard). */
  disabledCommands?: () => ReadonlySet<string>;
  /** Slack Web API operations, for the power-tool commands (br, jrp). */
  slack?: SlackAdminPort;
  /** GitHub actions the bot takes itself - the up-front approve in `review`. */
  github?: GitHubPort;
  /** AI reply drafting, for jrp. */
  draft?: DraftReply;
  /** Per-role CLI tool policy (sandbox/allow-list) applied to the chat brain. */
  toolPolicy?: (role: UserRole) => ToolPolicy;
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
  /** true when the command came in via a Slack slash command, not a message */
  viaSlash?: boolean;
};

export type HandleResult =
  | { kind: "reply"; text: string }
  | { kind: "denied"; text: string }
  | { kind: "ignored" };

export const handleMessage = async (
  deps: HandleMessageDeps,
  inbound: InboundMessage,
  sink?: LlmStreamSink,
): Promise<HandleResult> => {
  const text = cleanInboundText(inbound.text);
  if (!hasContent(text)) return { kind: "ignored" };

  const decision = decideAccess(inbound.slackUserId, deps.ownerSlackId, deps.users.get);
  if (!decision.allowed) return { kind: "denied", text: decision.reason };

  // Keep the allowlist's view of who this is current (owner is auto-provisioned).
  ensureUserRecord(deps, decision.user.slackId, decision.user.role, inbound.displayName);

  const now = deps.clock();
  deps.messages.append(
    {
      channelId: inbound.channelId,
      slackUserId: inbound.slackUserId,
      role: "user",
      content: text,
    },
    now,
  );

  const window = deps.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const history = deps.messages.recentForChannel(inbound.channelId, window);
  const ctx = deps.promptContext?.() ?? { learnings: [] };
  const system = buildSystemPrompt({
    botName: ctx.botName,
    base: ctx.base,
    learnings: ctx.learnings,
    addresseeName: inbound.displayName ?? decision.user.displayName,
    participants: collectParticipants(deps, history, inbound),
  });

  const params = {
    system,
    messages: buildContextWindow(history, window),
    assistantName: ctx.botName,
    policy: deps.toolPolicy?.(decision.user.role),
  };
  const reply = (
    sink && deps.llm.stream
      ? await deps.llm.stream(params, sink)
      : await deps.llm.complete(params)
  ).trim();

  const safeReply = reply.length > 0 ? reply : "I do not have anything useful to add there.";

  deps.messages.append(
    {
      channelId: inbound.channelId,
      // The bot authored this turn, not the human who prompted it.
      slackUserId: ASSISTANT_AUTHOR,
      role: "assistant",
      content: safeReply,
    },
    deps.clock(),
  );

  return { kind: "reply", text: safeReply };
};

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
