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
import { DEFAULT_SNUB_REPLY, isSnubbed, parseSnubbed } from "../domain/snub.ts";
import { SETTING_KEYS, type SettingsRepo } from "../infrastructure/db/settingsRepo.ts";
import type { SlackAdminPort } from "./slackAdmin.ts";
import type { AccessRequestRepo } from "../infrastructure/db/accessRequestRepo.ts";
import type { UserRepo } from "../infrastructure/db/userRepo.ts";
import { logAndIgnore } from "./ignoredError.ts";

/** Reactions the owner uses to decide. Aliases included - people reach for whichever. */
export const APPROVE_REACTIONS = ["white_check_mark", "heavy_check_mark", "ballot_box_with_check", "+1"];
export const REJECT_REACTIONS = ["x", "negative_squared_cross_mark", "no_entry", "no_entry_sign", "-1"];

/** Role granted on approval. Deliberately the lowest one. */
export const GRANTED_ROLE: UserRole = "pal";

/** Roles that may decide an access request. */
export const DECIDERS: readonly UserRole[] = ["owner", "admin"];

/** Excerpt of the message quoted to the owner. */
const ASKED_CHARS = 200;

/** How long a declined person waits before their asking counts again. */
export const REJECTED_COOLDOWN_MS = 24 * 60 * 60_000;

export type AccessRequestDeps = {
  users: UserRepo;
  accessRequests?: AccessRequestRepo;
  slack?: SlackAdminPort;
  clock: Clock;
  ownerSlackId: string;
  /**
   * Who is turned away for good, and what they are told. Settings rather than
   * source: a list of Slack ids and a line aimed at named colleagues is one
   * instance's business, and `src/` carries no instance identity.
   */
  settings?: SettingsRepo;
};

export type Requester = {
  slackUserId: string;
  displayName?: string;
  channelId: string;
  threadTs?: string;
  text: string;
};

/** The owner plus every admin, owner first, without repeats. */
const decidersOf = (deps: AccessRequestDeps): string[] => [
  ...new Set([
    deps.ownerSlackId,
    ...deps.users
      .list()
      .filter((u) => DECIDERS.includes(u.role))
      .map((u) => u.slackId),
  ]),
];

const clip = (s: string): string => (s.length > ASKED_CHARS ? `${s.slice(0, ASKED_CHARS)}…` : s);

/**
 * Put a stranger in front of the deciders and tell them so.
 *
 * Answers once and then goes quiet: whoever is waiting has been told, and
 * repeating it every time they speak turns one unanswered request into a wall
 * of identical replies - in their channel and in the deciders' DMs. Returns
 * undefined when the right response is to say nothing at all.
 */
export const requestAccess = async (
  deps: AccessRequestDeps,
  who: Requester,
  fallback: string,
): Promise<string | undefined> => {
  // Turned away for good: answered, never raised. Asking again costs nobody.
  if (isSnubbed(parseSnubbed(deps.settings?.get(SETTING_KEYS.snubbed)), who.slackUserId)) {
    return deps.settings?.get(SETTING_KEYS.snubReply)?.trim() || DEFAULT_SNUB_REPLY;
  }
  if (!deps.accessRequests || !deps.slack) return fallback;

  // Already waiting: they have been told once, and nothing has changed.
  if (deps.accessRequests.pendingFor(who.slackUserId)) return undefined;

  // Recently declined: asking again is not a new request, and must not raise a
  // second notice with everyone who already said no.
  const last = deps.accessRequests.latestFor(who.slackUserId);
  if (
    last?.status === "rejected" &&
    deps.clock() - (last.decidedAt ?? last.createdAt) < REJECTED_COOLDOWN_MS
  ) {
    return undefined;
  }

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
  const text = `🙋 <@${who.slackUserId}>${name} is asking me something and is not on the list.\n> ${clip(who.text)}\n\nReact ✅ to add them as *${GRANTED_ROLE}*, ❌ to decline.`;

  // Everyone who may decide has to be able to see it, so each of them gets the
  // notice and a reaction on any one of them resolves the request.
  let raised = 0;
  for (const id of decidersOf(deps)) {
    const notice = await deps.slack.postDm(id, text).catch(logAndIgnore("access request DM to decider"));
    if (!notice) continue;
    raised += 1;
    deps.accessRequests.addNotice(request.id, notice.channel, notice.ts);
  }
  if (raised === 0) return fallback; // nobody could be reached, so promise nothing

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
  // The owner always counts, even before they are in the allowlist.
  const clicker = deps.users.get(event.slackUserId);
  const mayDecide =
    event.slackUserId === deps.ownerSlackId || (clicker !== undefined && DECIDERS.includes(clicker.role));
  if (!mayDecide) return { kind: "ignored" };

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

  // Settle every notice so a second decider does not find live buttons.
  for (const n of deps.accessRequests.noticesFor(request.id)) {
    await deps.slack
      .settleInteractive(
        n.channel,
        n.ts,
        approve
          ? `✅ <@${request.slackUserId}> was added as *${GRANTED_ROLE}* by <@${event.slackUserId}>.`
          : `❌ <@${request.slackUserId}> was declined by <@${event.slackUserId}>.`,
      )
      .catch(logAndIgnore("access request decision notice"));
  }

  const toThem = approve
    ? `<@${request.slackUserId}> you are in ✅ ask me anything.`
    : `<@${request.slackUserId}> sorry, the owner said no this time.`;
  await deps.slack
    .post(request.channelId, toThem, request.threadTs || undefined)
    .catch(logAndIgnore("access request reply to requester"));
  return { kind: approve ? "approved" : "rejected", request };
};
