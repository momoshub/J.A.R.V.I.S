/**
 * Access requests - asking the owner instead of turning a stranger away.
 *
 * Someone the bot does not know used to get a flat "you are not on my access
 * list". Now the owner is asked: they get a DM with who spoke and what they
 * said, and their reaction decides it. ✅ adds the person as `pal` and tells
 * them where they asked; ❌ declines, in the same place.
 *
 * The request lives in the database, so the owner can take their time and a
 * restart does not strand anyone waiting.
 */
import type { AccessRequest, UserRole } from "../domain/types.ts";
import type { Clock } from "./ports.ts";
import type { SlackAdminPort } from "./slackAdmin.ts";
import type { AccessRequestRepo } from "../infrastructure/db/accessRequestRepo.ts";
import type { UserRepo } from "../infrastructure/db/userRepo.ts";

/** Reactions the owner uses to decide. Aliases included - people reach for whichever. */
export const APPROVE_REACTIONS = ["white_check_mark", "heavy_check_mark", "ballot_box_with_check", "+1"];
export const REJECT_REACTIONS = ["x", "negative_squared_cross_mark", "no_entry", "no_entry_sign", "-1"];

/** Role granted on approval. Deliberately the lowest one. */
export const GRANTED_ROLE: UserRole = "pal";

/** Excerpt of the message quoted to the owner. */
const ASKED_CHARS = 200;

export type AccessRequestDeps = {
  users: UserRepo;
  accessRequests?: AccessRequestRepo;
  slack?: SlackAdminPort;
  clock: Clock;
  ownerSlackId: string;
};

export type Requester = {
  slackUserId: string;
  displayName?: string;
  channelId: string;
  threadTs?: string;
  text: string;
};

const clip = (s: string): string => (s.length > ASKED_CHARS ? `${s.slice(0, ASKED_CHARS)}…` : s);

/**
 * Put a stranger in front of the owner and tell them so. Returns the line to
 * answer them with - including when nothing could be asked, in which case it
 * falls back to the old refusal rather than leaving them without a reply.
 */
export const requestAccess = async (
  deps: AccessRequestDeps,
  who: Requester,
  fallback: string,
): Promise<string> => {
  if (!deps.accessRequests || !deps.slack) return fallback;

  const existing = deps.accessRequests.pendingFor(who.slackUserId);
  if (existing) return "I have already asked about you - waiting on the owner 🙏";

  const request = deps.accessRequests.open(
    {
      slackUserId: who.slackUserId,
      displayName: who.displayName ?? "",
      channelId: who.channelId,
      threadTs: who.threadTs ?? "",
      asked: clip(who.text),
    },
    deps.clock(),
  );

  const name = who.displayName ? ` (${who.displayName})` : "";
  const notice = await deps.slack.postDm(
    deps.ownerSlackId,
    `🙋 <@${who.slackUserId}>${name} is asking me something and is not on the list.\n> ${clip(who.text)}\n\nReact ✅ to add them as *${GRANTED_ROLE}*, ❌ to decline.`,
  );
  if (!notice) return fallback; // could not reach the owner, so do not promise anything
  deps.accessRequests.setNotice(request.id, notice.channel, notice.ts);

  return "I do not know you yet, so I have asked the owner to let you in 🙏 I will reply here either way.";
};

export type ReactionOnNotice = {
  /** Who reacted; only the owner decides. */
  slackUserId: string;
  /** Reaction name, without colons. */
  reaction: string;
  channel: string;
  ts: string;
};

export type AccessDecision =
  | { kind: "approved"; request: AccessRequest }
  | { kind: "rejected"; request: AccessRequest }
  | { kind: "ignored" };

/**
 * Resolve a reaction the owner left on a notice. Anything else - another
 * person, another emoji, another message, a request already decided - is
 * ignored, so this is safe to call on every reaction in the workspace.
 */
export const decideAccessRequest = async (
  deps: AccessRequestDeps,
  event: ReactionOnNotice,
): Promise<AccessDecision> => {
  if (!deps.accessRequests || !deps.slack) return { kind: "ignored" };
  if (event.slackUserId !== deps.ownerSlackId) return { kind: "ignored" };

  const approve = APPROVE_REACTIONS.includes(event.reaction);
  const reject = REJECT_REACTIONS.includes(event.reaction);
  if (!approve && !reject) return { kind: "ignored" };

  const request = deps.accessRequests.byNotice(event.channel, event.ts);
  if (!request || request.status !== "pending") return { kind: "ignored" };

  const now = deps.clock();
  // A second reaction on an already-decided request loses the race and stops here.
  if (!deps.accessRequests.decide(request.id, approve ? "approved" : "rejected", now)) {
    return { kind: "ignored" };
  }

  if (approve) {
    deps.users.upsert({
      slackId: request.slackUserId,
      role: GRANTED_ROLE,
      displayName: request.displayName,
      addedBy: deps.ownerSlackId,
      createdAt: now,
    });
  }

  const toThem = approve
    ? `<@${request.slackUserId}> you are in ✅ ask me anything.`
    : `<@${request.slackUserId}> sorry, the owner said no this time.`;
  await deps.slack
    .post(request.channelId, toThem, request.threadTs || undefined)
    .catch(() => undefined);
  await deps.slack
    .postDm(
      deps.ownerSlackId,
      approve
        ? `✅ added <@${request.slackUserId}> as *${GRANTED_ROLE}*.`
        : `❌ declined <@${request.slackUserId}>.`,
    )
    .catch(() => undefined);

  return { kind: approve ? "approved" : "rejected", request };
};
