/**
 * Core chat use case: an allowed user says something, E.V. replies in character
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
import type { Clock, LlmPort, LlmStreamSink } from "./ports.ts";
import type { PromptContext } from "../domain/types.ts";
import type { MessageRepo } from "../infrastructure/db/messageRepo.ts";
import type { UserRepo } from "../infrastructure/db/userRepo.ts";

export type HandleMessageDeps = {
  users: UserRepo;
  messages: MessageRepo;
  llm: LlmPort;
  clock: Clock;
  ownerSlackId: string;
  contextWindow?: number;
  /** Supplies the editable base prompt + learnings; defaults to the built-in personality. */
  promptContext?: () => PromptContext;
};

export type InboundMessage = {
  channelId: string;
  slackUserId: string;
  text: string;
  /** best-effort display name from Slack, used to keep the allowlist fresh */
  displayName?: string;
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
  if (text.length === 0) return { kind: "ignored" };

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
    base: ctx.base,
    learnings: ctx.learnings,
    addresseeName: inbound.displayName ?? decision.user.displayName,
  });

  const params = { system, messages: buildContextWindow(history, window) };
  const reply = (
    sink && deps.llm.stream
      ? await deps.llm.stream(params, sink)
      : await deps.llm.complete(params)
  ).trim();

  const safeReply = reply.length > 0 ? reply : "I have got nothing useful to add there.";

  deps.messages.append(
    {
      channelId: inbound.channelId,
      slackUserId: inbound.slackUserId,
      role: "assistant",
      content: safeReply,
    },
    deps.clock(),
  );

  return { kind: "reply", text: safeReply };
};

const ensureUserRecord = (
  deps: HandleMessageDeps,
  slackId: string,
  role: "owner" | "admin" | "member",
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
