/**
 * Script loops: written by a turn, approved by the owner.
 *
 * A script loop is shell the bot runs on a timer with nobody present, so a
 * person never types one: they ask in plain words and the turn writes the
 * script. A turn may have read untrusted pages, so what it wrote is stored
 * PENDING - it never runs - and DMed to the owner with the exact schedule and
 * shell and Approve / Reject buttons. Only the owner's Approve activates it;
 * Reject, or no answer in 24h, deletes it.
 *
 * The press is handled HERE, in code, like `jv:cloudwatch:`: the model never
 * sees `jv:loop:` buttons, because a model that could press its own Approve
 * would make the guard decorative.
 */
import {
  LOOP_APPROVE_ACTION,
  LOOP_REJECT_ACTION,
  PENDING_TTL_MS,
  approvalText,
  nextRun,
  parseSchedule,
  settledLoopText,
} from "../domain/loop.ts";
import { SIGNATURES } from "../domain/messageFooter.ts";
import type { Loop, LoopRepo, NewLoop } from "../infrastructure/db/loopRepo.ts";
import type { Clock } from "./ports.ts";
import type { SlackAdminPort } from "./slackAdmin.ts";
import { logAndIgnore } from "./ignoredError.ts";

export type LoopApprovalDeps = {
  loops: LoopRepo;
  slack?: SlackAdminPort;
  clock: Clock;
  ownerSlackId: string;
  /** Minutes east of UTC that schedules are read in. */
  offsetMinutes: () => number;
  /** How long a pending loop waits. */
  ttlMs?: number;
  /** Timer for deleting an unanswered loop; injected so tests need not wait. */
  timer?: (fn: () => void, ms: number) => void;
  log?: (msg: string) => void;
};

const ttlOf = (deps: LoopApprovalDeps): number => deps.ttlMs ?? PENDING_TTL_MS;

const settle = (deps: LoopApprovalDeps, l: Loop, text: string): Promise<void> | undefined =>
  l.noticeChannel && l.noticeTs
    ? deps.slack?.settleInteractive(l.noticeChannel, l.noticeTs, text, SIGNATURES.loop).catch(logAndIgnore("loop approval settle"))
    : undefined;

/** Delete every pending loop past its time and settle its message. Safe to call on any timer. */
export const expirePendingLoops = async (deps: LoopApprovalDeps): Promise<number> => {
  const gone = deps.loops.expirePending(deps.clock(), ttlOf(deps));
  for (const l of gone) {
    deps.log?.(`loop ${l.id} expired unapproved`);
    await settle(deps, l, settledLoopText("expired", l.id));
  }
  return gone.length;
};

/**
 * Store a turn's script loop as pending and put it to the owner. What comes
 * back is what the turn tells the person: nothing has been scheduled yet.
 */
export const proposeScriptLoop = async (
  deps: LoopApprovalDeps,
  loop: Omit<NewLoop, "state">,
): Promise<{ ok: true; loop: Loop } | { ok: false; error: string }> => {
  if (!deps.slack?.postDmInteractive) {
    return { ok: false, error: "I cannot post the Approve / Reject message from here, so no script loop was created." };
  }
  const now = deps.clock();
  const l = deps.loops.add({ ...loop, state: "pending" }, now);
  const notice = await deps.slack
    .postDmInteractive(
      loop.createdBy,
      approvalText(l.id, l.schedule, l.command, ttlOf(deps)),
      [
        { actionId: LOOP_APPROVE_ACTION, label: "Approve", value: String(l.id), style: "primary" },
        { actionId: LOOP_REJECT_ACTION, label: "Reject", value: String(l.id), style: "danger" },
      ],
      SIGNATURES.loop,
    )
    .catch(logAndIgnore("loop approval post"));
  if (!notice) {
    deps.loops.discard(l.id);
    return { ok: false, error: "I could not DM the Approve / Reject message, so no script loop was created." };
  }
  deps.loops.setNotice(l.id, notice.channel, notice.ts);
  // Best effort: a restart loses the timer, and the runner's tick sweeps the rest.
  (deps.timer ?? ((fn, ms) => void setTimeout(fn, ms).unref?.()))(() => {
    void expirePendingLoops(deps).catch(logAndIgnore("loop expiry sweep"));
  }, ttlOf(deps) + 1_000);
  return { ok: true, loop: l };
};

export type LoopPressOutcome =
  | { kind: "approved" | "rejected"; id: number }
  | { kind: "refused" | "forged" }
  | { kind: "expired" | "decided" | "unknown" };

/**
 * An Approve or Reject press. Only the owner counts, and only on the approval
 * DM this loop was posted with, never edited since: a turn can post its own
 * `jv:loop:approve` button anywhere, and `chat.update` its own DM to show a
 * different command than the one stored.
 */
export const decideLoop = async (
  deps: LoopApprovalDeps,
  press: { slackUserId: string; actionId: string; value: string; channel?: string; messageTs?: string; edited?: boolean },
): Promise<LoopPressOutcome> => {
  if (press.actionId !== LOOP_APPROVE_ACTION && press.actionId !== LOOP_REJECT_ACTION) return { kind: "unknown" };
  const l = deps.loops.get(Number(press.value));
  if (!l || !l.command) return { kind: "unknown" };
  if (!l.noticeChannel || !l.noticeTs || press.channel !== l.noticeChannel || press.messageTs !== l.noticeTs || press.edited) {
    deps.log?.(`loop ${l.id} press refused: not the untouched approval DM`);
    return { kind: "forged" };
  }
  if (press.slackUserId !== deps.ownerSlackId) return { kind: "refused" };
  if (l.state !== "pending") return { kind: "decided" };
  const now = deps.clock();

  if (press.actionId === LOOP_REJECT_ACTION) {
    if (!deps.loops.discard(l.id)) return { kind: "decided" };
    deps.log?.(`loop ${l.id} rejected by ${press.slackUserId}`);
    await settle(deps, l, settledLoopText("rejected", l.id, press.slackUserId));
    return { kind: "rejected", id: l.id };
  }

  // Too old: the sweep may not have run yet, so the press itself deletes it.
  if (l.createdAt <= now - ttlOf(deps)) {
    await expirePendingLoops(deps);
    return { kind: "expired" };
  }
  const schedule = parseSchedule(l.schedule);
  if (!schedule) {
    deps.loops.discard(l.id);
    await settle(deps, l, "⚠️ script loop deleted - I could not read its schedule");
    return { kind: "decided" };
  }
  if (!deps.loops.activate(l.id, nextRun(schedule, now, deps.offsetMinutes()), now)) return { kind: "decided" };
  deps.log?.(`loop ${l.id} approved by ${press.slackUserId}`);
  await settle(deps, l, settledLoopText("approved", l.id, press.slackUserId));
  return { kind: "approved", id: l.id };
};
