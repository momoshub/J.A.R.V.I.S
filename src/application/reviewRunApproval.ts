/**
 * The owner's Approve / Reject on a review that has nobody's token to run on.
 *
 * Decided in code by its own Slack listener (the kit listener skips
 * `jv:review-run:`), never by a model turn: a turn that runs as the owner would
 * pass every check a command could make, so the bot could approve spending the
 * owner's credential with nobody pressing. Only a press carries `body.user.id`
 * and the channel/ts of the message pressed, and only the owner's counts.
 */
import {
  REVIEW_RUN_APPROVE_ACTION,
  REVIEW_RUN_REJECT_ACTION,
  reviewRunPressNotice,
  settledAskText,
} from "../domain/reviewIdentity.ts";
import { SIGNATURES } from "../domain/messageFooter.ts";
import type { ReviewRun, ReviewRunRepo } from "../infrastructure/db/reviewRunRepo.ts";
import { askLineOf } from "./autoReview.ts";
import { logAndIgnore } from "./ignoredError.ts";
import type { Clock } from "./ports.ts";
import type { SlackAdminPort } from "./slackAdmin.ts";

export type ReviewRunApprovalDeps = {
  runs: ReviewRunRepo;
  slack?: Pick<SlackAdminPort, "settleInteractive">;
  clock: Clock;
  ownerSlackId: string;
  /** Carry out the owner's decision (run the review, or leave a note). Not awaited by the press. */
  resolve: (run: ReviewRun, decision: "approved" | "rejected", by: string) => Promise<void>;
  log?: (msg: string) => void;
};

export type ReviewRunPressOutcome =
  | { readonly kind: "unknown" }
  | { readonly kind: "refused"; readonly why: "not-owner" | "wrong-message"; readonly id: number }
  | { readonly kind: "decided"; readonly id: number }
  | { readonly kind: "approved"; readonly id: number }
  | { readonly kind: "rejected"; readonly id: number };

export const decideReviewRunPress = async (
  deps: ReviewRunApprovalDeps,
  press: { slackUserId: string; actionId: string; value: string; channel?: string; messageTs?: string },
): Promise<ReviewRunPressOutcome> => {
  if (press.actionId !== REVIEW_RUN_APPROVE_ACTION && press.actionId !== REVIEW_RUN_REJECT_ACTION) return { kind: "unknown" };
  const id = Number(press.value);
  const run = Number.isInteger(id) ? deps.runs.get(id) : undefined;
  if (!run) return { kind: "unknown" };
  if (press.slackUserId !== deps.ownerSlackId) return { kind: "refused", why: "not-owner", id: run.id };
  // Only the message the question went out on: the stored channel and ts, never ones the press makes up.
  if (!run.askChannel || !run.askTs || press.channel !== run.askChannel || press.messageTs !== run.askTs) {
    return { kind: "refused", why: "wrong-message", id: run.id };
  }
  const decision = press.actionId === REVIEW_RUN_APPROVE_ACTION ? "approved" : "rejected";
  // The move is the decision: only one press (or one owner on two devices) gets it.
  if (!deps.runs.move(run.id, ["asking"], decision === "approved" ? "running" : "rejected", deps.clock())) {
    return { kind: "decided", id: run.id };
  }
  await deps.slack
    ?.settleInteractive(run.askChannel, run.askTs, settledAskText(askLineOf(run, deps.ownerSlackId), decision, press.slackUserId), SIGNATURES.reviewInbox)
    .catch(logAndIgnore("review run settle"));
  void deps.resolve({ ...run, state: decision === "approved" ? "running" : "rejected" }, decision, press.slackUserId).catch((e: unknown) =>
    deps.log?.(`resolving review ${run.id} failed: ${e instanceof Error ? e.message : String(e)}`),
  );
  return { kind: decision === "approved" ? "approved" : "rejected", id: run.id };
};

/** What a press that changed nothing is told, privately. */
export const reviewRunPressNoticeOf = (o: ReviewRunPressOutcome): string | undefined =>
  o.kind === "refused" ? reviewRunPressNotice(o.why) : o.kind === "decided" ? reviewRunPressNotice("decided") : undefined;
