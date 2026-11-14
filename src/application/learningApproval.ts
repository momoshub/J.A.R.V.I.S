/**
 * Learnings: written by anyone, approved by the owner.
 *
 * Only the owner typing `learn <fact>` saves one active. A member's `learn`, a
 * `learn` the agent runs for itself and every POST to the learnings API are
 * stored PENDING - they never reach a prompt - and put to the owner in a DM
 * with Approve / Reject buttons (or `learn approve <id>` / `learn reject <id>`).
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
} from "../domain/learning.ts";
import { SIGNATURES } from "../domain/messageFooter.ts";
import type { Learning } from "../domain/types.ts";
import type { LearningsRepo } from "../infrastructure/db/learningsRepo.ts";
import type { Clock } from "./ports.ts";
import type { SlackAdminPort } from "./slackAdmin.ts";
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

/** Put a pending learning to the owner. A failed DM only logs: `learn pending` still lists it. */
const askOwner = async (deps: LearningApprovalDeps, l: Learning, by: string): Promise<void> => {
  if (!deps.slack?.postDmInteractive) {
    deps.log?.(`learning #${l.id} pending, no way to DM the owner`);
    return;
  }
  const notice = await deps.slack
    .postDmInteractive(
      deps.ownerSlackId,
      approvalText(l.id, l.content, by),
      [
        { actionId: LEARNING_APPROVE_ACTION, label: "Approve", value: String(l.id), style: "primary" },
        { actionId: LEARNING_REJECT_ACTION, label: "Reject", value: String(l.id), style: "danger" },
      ],
      SIGNATURES.learning,
    )
    .catch(logAndIgnore("learning approval post"));
  if (notice) deps.learnings.setNotice(l.id, notice.channel, notice.ts);
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
export const proposeLearning = async (deps: LearningApprovalDeps, fact: string, by: string): Promise<Proposed> => {
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
  const l = deps.learnings.add(text, by, deps.clock(), "pending");
  deps.log?.(`learning #${l.id} proposed by ${by}, pending the owner`);
  await askOwner(deps, l, by);
  return { ok: true, learning: l };
};

export type DecideResult =
  | { readonly kind: "approved" | "rejected"; readonly learning: Learning; readonly warnings: readonly string[] }
  | { readonly kind: "failed"; readonly violations: readonly string[] }
  | { readonly kind: "refused"; readonly why: DecisionRefusal };

const settle = (deps: LearningApprovalDeps, l: Learning, text: string): Promise<void> | undefined =>
  l.noticeChannel && l.noticeTs
    ? deps.slack?.settleInteractive(l.noticeChannel, l.noticeTs, text, SIGNATURES.learning).catch(logAndIgnore("learning approval settle"))
    : undefined;

/**
 * Apply the owner's decision to a pending learning. The caller has already
 * checked WHO decided (the command's role, the button's user); this checks
 * only the learning, and claims it once, so a double press changes nothing.
 */
export const decideLearning = async (
  deps: LearningApprovalDeps,
  id: number,
  decision: "approve" | "reject",
  by: string,
): Promise<DecideResult> => {
  const l = deps.learnings.get(id);
  if (!l) return { kind: "refused", why: "unknown" };
  if (l.status !== "pending") return { kind: "refused", why: "decided" };
  const now = deps.clock();

  if (decision === "reject") {
    if (!deps.learnings.decide(id, "rejected", by, now)) return { kind: "refused", why: "decided" };
    deps.log?.(`learning #${id} rejected by ${by}`);
    await settle(deps, l, settledText("rejected", id, l.content, by));
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
  await settle(deps, l, settledText("approved", id, l.content, by));
  return { kind: "approved", learning: l, warnings };
};

/** Slack's three entities back to the characters, `&amp;` last so `&amp;gt;` stays `&gt;`. */
const unescapeSlack = (text: string): string => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

export type PressOutcome =
  | { readonly kind: "approved" | "rejected"; readonly id: number }
  | { readonly kind: "refused"; readonly why: DecisionRefusal; readonly id?: number }
  | { readonly kind: "failed"; readonly violations: readonly string[] }
  | { readonly kind: "unknown" };

/**
 * An Approve or Reject press. Only the owner counts, and only on the DM this
 * learning was posted with, never edited since: a turn can post its own
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
  },
): Promise<PressOutcome> => {
  if (press.actionId !== LEARNING_APPROVE_ACTION && press.actionId !== LEARNING_REJECT_ACTION) return { kind: "unknown" };
  const l = deps.learnings.get(Number(press.value));
  if (!l) return { kind: "unknown" };
  // Slack does not reliably flag an app's own chat.update as edited, so what the message shows decides.
  // Slack hands block text back with its own escaping (the quote's `>` comes back as `&gt;`), so both sides are unescaped first.
  const showsTheFact = unescapeSlack((press.shown ?? []).join("\n")).includes(unescapeSlack(approvalCore(l.content)));
  const fromTheDm = !!l.noticeChannel && !!l.noticeTs && press.channel === l.noticeChannel && press.messageTs === l.noticeTs;
  if (!fromTheDm || press.edited || !showsTheFact) {
    deps.log?.(`learning #${l.id} press refused: not the untouched approval DM`);
    return { kind: "refused", why: "forged", id: l.id };
  }
  if (press.slackUserId !== deps.ownerSlackId) return { kind: "refused", why: "not-owner", id: l.id };
  const r = await decideLearning(deps, l.id, press.actionId === LEARNING_APPROVE_ACTION ? "approve" : "reject", press.slackUserId);
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
