/**
 * Per-role command allowance, and the approval that follows running out.
 *
 * A `pal` gets a fixed number of commands in a rolling window. Past that the
 * command is not refused - it is parked and put to the owner with Approve /
 * Reject buttons, so the limit slows someone down without stopping them.
 *
 * Only `pal` is limited. Higher roles are trusted with the shell already, so
 * counting their commands would be theatre.
 */
import type { AllowedUser, UserRole } from "../domain/types.ts";
import type { Clock } from "./ports.ts";
import type { SlackAdminPort } from "./slackAdmin.ts";
import type { CommandLogRepo } from "../infrastructure/db/commandLogRepo.ts";
import type { CommandApprovalRepo } from "../infrastructure/db/commandApprovalRepo.ts";
import type { UserRepo } from "../infrastructure/db/userRepo.ts";
import type { SettingsRepo } from "../infrastructure/db/settingsRepo.ts";

/** Commands a limited role may run per window, unless given their own. */
export const PAL_COMMAND_LIMIT = 10;

/** Settings key holding one person's own allowance. */
export const limitKey = (slackUserId: string): string => `command_limit:${slackUserId}`;
/** The rolling window the allowance is measured over. */
export const PAL_WINDOW_MS = 4 * 60 * 60_000;
/** Roles the allowance applies to. */
export const LIMITED_ROLES: readonly UserRole[] = ["pal"];

/** Slack action ids on the approval buttons. */
export const APPROVE_ACTION = "command_approve";
export const REJECT_ACTION = "command_reject";

/** Roles allowed to press those buttons. */
const DECIDERS: readonly UserRole[] = ["owner", "admin"];

export type CommandLimitDeps = {
  users: UserRepo;
  /** Holds per-person allowance overrides, set by an admin. */
  settings?: SettingsRepo;
  commandLog?: CommandLogRepo;
  commandApprovals?: CommandApprovalRepo;
  slack?: SlackAdminPort;
  clock: Clock;
  ownerSlackId: string;
};

export type Allowance = {
  limited: boolean;
  used: number;
  limit: number;
  /** When the window rolls far enough for another command. */
  resetsAt?: number;
};

/** This person's allowance: their own if an admin set one, otherwise the default. */
export const limitFor = (deps: CommandLimitDeps, slackUserId: string): number => {
  const raw = deps.settings?.get(limitKey(slackUserId));
  // An empty value is "no override" - not zero, which would silently gate
  // every command the moment someone was put back on the default.
  if (!raw) return PAL_COMMAND_LIMIT;
  const own = Number(raw);
  return Number.isInteger(own) && own >= 0 ? own : PAL_COMMAND_LIMIT;
};

/** Give someone their own allowance, or `undefined` to put them back on the default. */
export const setLimit = (deps: CommandLimitDeps, slackUserId: string, limit?: number): void => {
  if (limit === undefined) deps.settings?.set(limitKey(slackUserId), "");
  else deps.settings?.set(limitKey(slackUserId), String(Math.max(0, Math.floor(limit))));
};

/** Where this person stands against their allowance right now. */
export const allowanceFor = (
  deps: CommandLimitDeps,
  actor: AllowedUser,
  /** Command names that do not count (trivial ones). */
  uncounted: readonly string[],
): Allowance => {
  const limit = limitFor(deps, actor.slackId);
  if (!LIMITED_ROLES.includes(actor.role) || !deps.commandLog) {
    return { limited: false, used: 0, limit };
  }
  const now = deps.clock();
  const used = deps.commandLog.countSince(actor.slackId, now - PAL_WINDOW_MS, uncounted);
  return { limited: used >= limit, used, limit, resetsAt: now + PAL_WINDOW_MS };
};

const hours = (ms: number): string => {
  const h = Math.round(ms / 3_600_000);
  return h <= 1 ? "an hour" : `${h} hours`;
};

/**
 * Park a command and ask for approval. Returns what to tell the person who
 * asked - including when the request could not be raised, so they are never
 * left thinking something is coming.
 */
export const holdForApproval = async (
  deps: CommandLimitDeps,
  actor: AllowedUser,
  line: string,
  channelId: string,
  threadTs: string | undefined,
  allowance: Allowance,
): Promise<string> => {
  if (!deps.commandApprovals || !deps.slack) {
    return `You have used all ${allowance.limit} of your commands for the next ${hours(PAL_WINDOW_MS)}.`;
  }

  const held = deps.commandApprovals.open(
    {
      slackUserId: actor.slackId,
      displayName: actor.displayName,
      channelId,
      threadTs: threadTs ?? "",
      line,
    },
    deps.clock(),
  );

  const notice = await deps.slack.postDmInteractive(
    deps.ownerSlackId,
    `⏳ <@${actor.slackId}> has used all ${allowance.limit} commands in the last ${hours(PAL_WINDOW_MS)} and wants to run \`${line}\`.`,
    [
      { actionId: APPROVE_ACTION, label: "Approve", value: String(held.id), style: "primary" },
      { actionId: REJECT_ACTION, label: "Reject", value: String(held.id), style: "danger" },
    ],
  );
  if (notice) deps.commandApprovals.setNotice(held.id, notice.channel, notice.ts);

  return `You have hit your limit of ${allowance.limit} commands per ${hours(PAL_WINDOW_MS)} ⏳ I have asked <@${deps.ownerSlackId}> to approve this one.`;
};

export type ButtonPress = {
  /** Who clicked. Only owner and admin count. */
  slackUserId: string;
  actionId: string;
  /** The approval id carried on the button. */
  value: string;
};

export type ApprovalOutcome =
  | { kind: "approved"; result: string; line: string; requester: string }
  | { kind: "rejected"; requester: string }
  | { kind: "ignored"; reason: "not-allowed" | "unknown" | "already-decided" };

/**
 * Resolve an Approve / Reject press. `run` executes the parked command as the
 * person who asked for it, so approving grants this one command and nothing
 * more - not the clicker's authority.
 */
export const decideCommandApproval = async (
  deps: CommandLimitDeps,
  press: ButtonPress,
  run: (approval: { actor: AllowedUser; line: string; channelId: string; threadTs?: string }) => Promise<string>,
): Promise<ApprovalOutcome> => {
  if (!deps.commandApprovals || !deps.slack) return { kind: "ignored", reason: "unknown" };
  if (press.actionId !== APPROVE_ACTION && press.actionId !== REJECT_ACTION) {
    return { kind: "ignored", reason: "unknown" };
  }

  const clicker = deps.users.get(press.slackUserId);
  const isOwner = press.slackUserId === deps.ownerSlackId;
  if (!isOwner && !(clicker && DECIDERS.includes(clicker.role))) {
    return { kind: "ignored", reason: "not-allowed" };
  }

  const held = deps.commandApprovals.get(Number(press.value));
  if (!held) return { kind: "ignored", reason: "unknown" };

  const approve = press.actionId === APPROVE_ACTION;
  if (!deps.commandApprovals.decide(held.id, approve ? "approved" : "rejected", press.slackUserId, deps.clock())) {
    return { kind: "ignored", reason: "already-decided" };
  }

  if (!approve) {
    await deps.slack
      .post(held.channelId, `<@${held.slackUserId}> that one was not approved.`, held.threadTs || undefined)
      .catch(() => undefined);
    return { kind: "rejected", requester: held.slackUserId };
  }

  const actor = deps.users.get(held.slackUserId);
  if (!actor) return { kind: "ignored", reason: "unknown" };
  const result = await run({
    actor,
    line: held.line,
    channelId: held.channelId,
    threadTs: held.threadTs || undefined,
  });
  if (result.trim()) {
    await deps.slack.post(held.channelId, result, held.threadTs || undefined).catch(() => undefined);
  }
  return { kind: "approved", result, line: held.line, requester: held.slackUserId };
};
