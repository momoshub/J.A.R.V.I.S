/**
 * Learnings: written by anyone, approved by the owner.
 *
 * Only the owner typing `learn <fact>` saves one active. A member's `learn`, a
 * `learn` the agent runs for itself and every POST to the learnings API are
 * stored PENDING - they never reach a prompt - and put to the owner (in the thread of the turn that proposed it when that is the
 * owner's own, otherwise in their DM) with Approve / Reject buttons (or `learn approve <id>` / `learn reject <id>`).
 * A press is handled HERE, in code, like `jv:loop:`: the model never sees these
 * buttons, because a model that could press its own Approve would make the
 * guard decorative.
 *
 * Memory is either the flat `learnings` table or the adapter. Pending rows
 * always live in the table; approving one in adapter mode files the fact into
 * the adapter (where the prompt reads it) and drops the row, so there is still
 * ONE store of what the bot knows.
 */
import { rememberFact, type AdapterDeps } from "./adapterMemory.ts";
import {
  AGENT_SOURCE,
  LEARNING_APPROVE_ACTION,
  LEARNING_REJECT_ACTION,
  MAX_LEARNING_CHARS,
  approvalCore,
  approvalText,
  oneLine,
  settledText,
  type DecisionRefusal,
  type LearningSource,
} from "../domain/learning.ts";
import { SIGNATURES } from "../domain/messageFooter.ts";
import { noticeFingerprint, withoutEmoji } from "../domain/noticeFingerprint.ts";
import type { Learning } from "../domain/types.ts";
import type { LearningsRepo } from "../infrastructure/db/learningsRepo.ts";
import type { Clock } from "./ports.ts";
import type { InteractiveAction, SlackAdminPort } from "./slackAdmin.ts";
import { logAndIgnore } from "./ignoredError.ts";

/** Pending learnings at once: past this, new ones are refused so the owner's DMs cannot be flooded. */
export const MAX_PENDING = 20;

export type LearningApprovalDeps = {
  learnings: LearningsRepo;
  /** The live memory adapter, read per call (it can appear after boot); absent means the flat list. */
  adapter?: () => AdapterDeps | undefined;
  slack?: SlackAdminPort;
  clock: Clock;
  ownerSlackId: string;
  log?: (msg: string) => void;
};

/**
 * The learnings that reach a prompt. The one place the injection reads from:
 * active only, filtered here as well as in the repo, so a change to either
 * cannot start injecting a pending or rejected fact.
 */
export const injectedLearnings = (learnings: LearningsRepo): string[] =>
  learnings
    .list()
    .filter((l) => l.status === "active")
    .map((l) => l.content);

export type Saved =
  | { readonly ok: true; readonly id?: number; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly violations: readonly string[] };

/** Save active. Only for the owner's own typed `learn`: everything else goes through `proposeLearning`. */
export const saveActive = (deps: LearningApprovalDeps, fact: string, by: string): Saved => {
  const text = oneLine(fact);
  const adapter = deps.adapter?.();
  if (adapter) {
    const r = rememberFact(adapter, text, { kind: "global" }, by);
    return r.ok ? { ok: true, warnings: r.warnings } : { ok: false, violations: r.violations };
  }
  const l = deps.learnings.add(text, by, deps.clock(), "active");
  return { ok: true, id: l.id, warnings: [] };
};

/**
 * Is the turn's thread the owner's own? Their DM with the bot, or a thread they
 * started anywhere: the notice (and the fact in it) then lands where the owner
 * is already reading. A thread someone else started is not, whoever else is in
 * it, so a member's conversation never carries the owner's decision.
 */
const ownerOwnsThread = async (deps: LearningApprovalDeps, channel: string, threadTs: string): Promise<boolean> => {
  if (!channel || !threadTs || !deps.slack) return false;
  const dm = await deps.slack.openDm?.(deps.ownerSlackId).catch(logAndIgnore("learning source owner dm"));
  if (dm === channel) return true;
  const root = await deps.slack.lookup?.(channel, threadTs).catch(logAndIgnore("learning source thread root"));
  return root?.userId === deps.ownerSlackId;
};

/**
 * Put a pending learning to the owner: in the thread of the turn that proposed
 * it when that is the owner's own (the press check reads the posted message's
 * channel and ts back from the row, so it holds wherever the notice lands),
 * otherwise in the owner's DM with a link to that thread. A failed post only
 * logs: `learn pending` still lists it.
 */
const askOwner = async (deps: LearningApprovalDeps, l: Learning, by: string): Promise<void> => {
  if (!deps.slack?.postDmInteractive) {
    deps.log?.(`learning #${l.id} pending, no way to DM the owner`);
    return;
  }
  const actions = [
    { actionId: LEARNING_APPROVE_ACTION, label: "Approve", value: String(l.id), style: "primary" },
    { actionId: LEARNING_REJECT_ACTION, label: "Reject", value: String(l.id), style: "danger" },
  ] as const;
  const inThread =
    !!deps.slack.postInteractive && (await ownerOwnsThread(deps, l.sourceChannel, l.sourceThreadTs));
  const threaded = inThread
    ? await deps.slack
        .postInteractive?.(l.sourceChannel, approvalText(l.id, l.content, by), actions, l.sourceThreadTs, SIGNATURES.learning)
        .catch(logAndIgnore("learning approval thread post"))
    : undefined;
  if (threaded) {
    deps.learnings.setNotice(l.id, threaded.channel, threaded.ts, threaded.fingerprint);
    return;
  }
  const link =
    l.sourceChannel && l.sourceThreadTs
      ? await deps.slack.permalink?.(l.sourceChannel, l.sourceThreadTs).catch(logAndIgnore("learning source permalink"))
      : undefined;
  const notice = await deps.slack
    .postDmInteractive(deps.ownerSlackId, approvalText(l.id, l.content, by, link), actions, SIGNATURES.learning)
    .catch(logAndIgnore("learning approval post"));
  if (notice) deps.learnings.setNotice(l.id, notice.channel, notice.ts, notice.fingerprint);
  else deps.log?.(`learning #${l.id} pending, the owner DM did not go out`);
};

export type Proposed =
  | { readonly ok: true; readonly learning: Learning }
  | { readonly ok: false; readonly error: string };

/**
 * Park a fact for the owner: stored pending, never injected. `by` is who asked
 * (a Slack id) or `AGENT_SOURCE`. The same fact already waiting is not asked
 * twice, so an agent that retries does not stack DMs.
 */
export const proposeLearning = async (
  deps: LearningApprovalDeps,
  fact: string,
  by: string,
  source?: LearningSource,
): Promise<Proposed> => {
  const text = oneLine(fact);
  if (!text) return { ok: false, error: "Empty learning" };
  if (text.length > MAX_LEARNING_CHARS) {
    return { ok: false, error: `Too long (${text.length} characters, at most ${MAX_LEARNING_CHARS}). One sentence.` };
  }
  const waiting = deps.learnings.pending();
  const same = waiting.find((l) => l.content === text);
  if (same) return { ok: true, learning: same };
  if (waiting.length >= MAX_PENDING) {
    return { ok: false, error: `${waiting.length} learnings are already waiting for the owner. Try again once they have decided.` };
  }
  const l = deps.learnings.add(text, by, deps.clock(), "pending", source);
  deps.log?.(`learning #${l.id} proposed by ${by}, pending the owner`);
  await askOwner(deps, l, by);
  return { ok: true, learning: l };
};

export type DecideResult =
  | { readonly kind: "approved" | "rejected"; readonly learning: Learning; readonly warnings: readonly string[] }
  | { readonly kind: "failed"; readonly violations: readonly string[] }
  | { readonly kind: "refused"; readonly why: DecisionRefusal };

/**
 * The buttons a decided notice keeps: both stay, the pressed one relabelled with
 * who decided (a button's text is plain, so a name and never a mention), the
 * other still pressable to flip the decision. `canFlip` is false for an approval
 * filed into the adapter: its row is gone, so there is nothing left to reject.
 */
const decidedActions = (id: number, decision: "approve" | "reject", who: string, canFlip: boolean): InteractiveAction[] => {
  const approved = decision === "approve";
  const done: InteractiveAction = approved
    ? { actionId: LEARNING_APPROVE_ACTION, label: `:white_check_mark: Approved by ${who}`, value: String(id), style: "primary" }
    : { actionId: LEARNING_REJECT_ACTION, label: `:x: Rejected by ${who}`, value: String(id), style: "danger" };
  const other: InteractiveAction = approved
    ? { actionId: LEARNING_REJECT_ACTION, label: "Reject", value: String(id), style: "danger" }
    : { actionId: LEARNING_APPROVE_ACTION, label: "Approve", value: String(id), style: "primary" };
  if (!canFlip) return [done];
  return approved ? [done, other] : [other, done];
};

/** Rewrite the learning's notice to show the decision and keep the buttons; a port without `updateInteractive` settles it plainly. */
const settle = async (
  deps: LearningApprovalDeps,
  l: Learning,
  decision: "approve" | "reject",
  by: string,
  canFlip: boolean,
): Promise<void> => {
  if (!l.noticeChannel || !l.noticeTs || !deps.slack) return;
  const text = settledText(decision === "approve" ? "approved" : "rejected", l.id, l.content, by);
  const { noticeChannel: channel, noticeTs: ts } = l;
  if (!deps.slack.updateInteractive) {
    deps.learnings.setNoticeFingerprint(l.id, "");
    await deps.slack.settleInteractive(channel, ts, text, SIGNATURES.learning).catch(logAndIgnore("learning approval settle"));
    return;
  }
  const names = await deps.slack.resolveNames?.([by]).catch(logAndIgnore("learning decider name"));
  const who = (names?.[by] ?? "").trim() || "the owner";
  // Whatever happens next, the message no longer matches the old fingerprint: clear it first, set the new one once the rewrite landed.
  deps.learnings.setNoticeFingerprint(l.id, "");
  const fingerprint = await deps.slack
    .updateInteractive(channel, ts, text, decidedActions(l.id, decision, who.slice(0, 40), canFlip), SIGNATURES.learning)
    .catch(logAndIgnore("learning approval settle"));
  if (fingerprint) deps.learnings.setNoticeFingerprint(l.id, fingerprint);
};

/**
 * Apply the owner's decision to a pending learning. The caller has already
 * checked WHO decided (the command's role, the button's user); this checks
 * only the learning, and claims it once, so a double press changes nothing.
 * `flip` (a press on the kept button of an answered notice) also takes a
 * learning already decided the other way; the typed `learn approve|reject`
 * stays pending-only.
 */
export const decideLearning = async (
  deps: LearningApprovalDeps,
  id: number,
  decision: "approve" | "reject",
  by: string,
  opts: { readonly flip?: boolean } = {},
): Promise<DecideResult> => {
  const l = deps.learnings.get(id);
  if (!l) return { kind: "refused", why: "unknown" };
  const target = decision === "approve" ? "active" : "rejected";
  if (opts.flip ? l.status === target : l.status !== "pending") return { kind: "refused", why: "decided" };
  const now = deps.clock();

  if (decision === "reject") {
    if (!deps.learnings.decide(id, "rejected", by, now)) return { kind: "refused", why: "decided" };
    deps.log?.(`learning #${id} rejected by ${by}`);
    await settle(deps, l, "reject", by, true);
    return { kind: "rejected", learning: l, warnings: [] };
  }

  // Filed first, claimed second: a refused write leaves the learning pending.
  // Nothing awaits between the read above and the claim, so no press slips in.
  const adapter = deps.adapter?.();
  let warnings: readonly string[] = [];
  if (adapter) {
    const r = rememberFact(adapter, l.content, { kind: "global" }, by);
    if (!r.ok) return { kind: "failed", violations: r.violations };
    warnings = r.warnings;
  }
  if (!deps.learnings.decide(id, "active", by, now)) return { kind: "refused", why: "decided" };
  // The adapter holds it now and is what the prompt reads; the row would only be a second copy.
  if (adapter) deps.learnings.remove(id);
  deps.log?.(`learning #${id} approved by ${by}`);
  await settle(deps, l, "approve", by, !adapter);
  return { kind: "approved", learning: l, warnings };
};

export type PressOutcome =
  | { readonly kind: "approved" | "rejected"; readonly id: number }
  | { readonly kind: "refused"; readonly why: DecisionRefusal; readonly id?: number }
  | { readonly kind: "failed"; readonly violations: readonly string[] }
  | { readonly kind: "unknown" };

/**
 * An Approve or Reject press, also on a notice already answered (the other
 * button flips the decision). Only the owner counts, and only on the message this
 * learning was posted with, never edited by anyone else: a turn can post its own
 * `jv:learning:approve` button anywhere, or `chat.update` its own DM so the
 * owner approves a different fact than the one stored.
 */
export const decideLearningPress = async (
  deps: LearningApprovalDeps,
  press: {
    slackUserId: string;
    actionId: string;
    value: string;
    channel?: string;
    messageTs?: string;
    edited?: boolean;
    /** The texts the pressed message shows (its blocks), as Slack sent them back. */
    shown?: readonly string[];
    /** The pressed message's blocks as Slack sent them back: compared whole against what was last rendered. */
    blocks?: readonly unknown[];
  },
): Promise<PressOutcome> => {
  if (press.actionId !== LEARNING_APPROVE_ACTION && press.actionId !== LEARNING_REJECT_ACTION) return { kind: "unknown" };
  const l = deps.learnings.get(Number(press.value));
  if (!l) return { kind: "unknown" };
  // Slack does not reliably flag an app's own chat.update as edited, so what the message shows decides.
  // Slack hands the quote marker back as `&gt; `, so either form of the marker counts. The fact itself stays
  // compared escaped: a raw `<` shown (a live link or mention) never matches the stored `&lt;`.
  // Emoji are dropped on both sides: Slack echoes them as shortcodes, so a fact with one would never match.
  const core = withoutEmoji(approvalCore(l.content));
  const shown = withoutEmoji((press.shown ?? []).join("\n"));
  const showsTheFact = shown.includes(core) || shown.includes(`&gt; ${core.slice(2)}`);
  const fromTheDm = !!l.noticeChannel && !!l.noticeTs && press.channel === l.noticeChannel && press.messageTs === l.noticeTs;
  // The whole message, not the fact in it: text, buttons (ids, labels) and block layout must be what was last rendered.
  // An empty stored fingerprint is a notice posted before this check existed; only a still-pending one may rely on the
  // old checks (a decided notice only has buttons because it was rewritten, which stores one).
  const sameMessage = l.noticeFingerprint
    ? press.blocks !== undefined && noticeFingerprint(press.blocks) === l.noticeFingerprint
    : l.status === "pending" && !press.edited;
  if (!fromTheDm || !sameMessage || (press.edited && l.status === "pending") || !showsTheFact) {
    deps.log?.(`learning #${l.id} press refused: not the untouched approval DM`);
    return { kind: "refused", why: "forged", id: l.id };
  }
  if (press.slackUserId !== deps.ownerSlackId) return { kind: "refused", why: "not-owner", id: l.id };
  const r = await decideLearning(deps, l.id, press.actionId === LEARNING_APPROVE_ACTION ? "approve" : "reject", press.slackUserId, { flip: true });
  return r.kind === "refused"
    ? { kind: "refused", why: r.why, id: l.id }
    : r.kind === "failed"
      ? r
      : { kind: r.kind, id: l.id };
};

/**
 * New wording for an existing learning. Rewording is a write like any other:
 * unless the owner typed it, the learning goes back to pending (and out of the
 * prompt) until the owner approves the new text, or the agent could rewrite an
 * approved fact instead of adding one. It counts toward `MAX_PENDING`, a
 * rejected learning stays rejected and one already waiting is not reworded.
 */
export const rewordLearning = async (
  deps: LearningApprovalDeps,
  id: number,
  fact: string,
  by: { readonly slackId: string; readonly owner: boolean },
): Promise<{ readonly ok: true; readonly learning: Learning; readonly pending: boolean } | { readonly ok: false; readonly error: string }> => {
  const text = oneLine(fact);
  const before = deps.learnings.get(id);
  if (!before) return { ok: false, error: `I have no learning #${id}.` };
  if (!text) return { ok: false, error: "Empty learning" };
  if (by.owner) {
    deps.learnings.update(id, text, before.status);
    return { ok: true, learning: { ...before, content: text }, pending: false };
  }
  if (text.length > MAX_LEARNING_CHARS) {
    return { ok: false, error: `Too long (${text.length} characters, at most ${MAX_LEARNING_CHARS}). One sentence.` };
  }
  if (text === before.content) return { ok: true, learning: before, pending: before.status === "pending" };
  // Same limits as a new proposal, or this door floods the owner's DMs and brings back what they rejected.
  if (before.status === "rejected") return { ok: false, error: `Learning #${id} was rejected by the owner.` };
  if (before.status === "pending") return { ok: false, error: `Learning #${id} is already waiting for the owner. It cannot be reworded until they decide.` };
  const waiting = deps.learnings.pending().length;
  if (waiting >= MAX_PENDING) {
    return { ok: false, error: `${waiting} learnings are already waiting for the owner. Try again once they have decided.` };
  }
  deps.learnings.update(id, text, "pending");
  deps.log?.(`learning #${id} reworded by ${by.slackId || AGENT_SOURCE}, pending the owner`);
  const after = deps.learnings.get(id) ?? { ...before, content: text, status: "pending" as const };
  await askOwner(deps, after, by.slackId || AGENT_SOURCE);
  return { ok: true, learning: after, pending: true };
};
