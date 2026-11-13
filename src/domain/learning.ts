/**
 * Learnings need the owner's approval.
 *
 * A learning is injected into every future reply, in every channel, for
 * everyone, so whoever can write one controls the bot for good: one prompt
 * injection that makes the agent POST a learning poisons it permanently. Only
 * the owner typing `learn <fact>` themselves is saved active. Everything else
 * (a member's `learn`, the agent's `learn` or POST to the learnings API, in
 * any turn) is stored PENDING, never reaches a prompt, and waits for the
 * owner's Approve / Reject.
 *
 * Pure: wording, the `learn` argument grammar and the rules of a decision.
 */
import { escapeForSlack } from "./loop.ts";

/** `pending` waits for the owner and is never injected; only `active` reaches a prompt. */
export type LearningStatus = "pending" | "active" | "rejected";

/** Who a learning is credited to when the agent wrote it, through the API or the run bridge. */
export const AGENT_SOURCE = "agent";

/** One sentence: the whole fact has to fit the approval DM the owner decides on. */
export const MAX_LEARNING_CHARS = 1000;

/** Button ids. `jv:` like every element of ours, but decided in code, never handed to the model. */
export const LEARNING_ACTION_PREFIX = "jv:learning:";
export const LEARNING_APPROVE_ACTION = `${LEARNING_ACTION_PREFIX}approve`;
export const LEARNING_REJECT_ACTION = `${LEARNING_ACTION_PREFIX}reject`;

/** A fact on one line, the way it is stored and shown. */
export const oneLine = (fact: string): string => fact.trim().replace(/\s*\n+\s*/g, " ");

export type LearnArgs =
  | { readonly kind: "fact"; readonly text: string }
  | { readonly kind: "pending" }
  | { readonly kind: "approve"; readonly id: number }
  | { readonly kind: "reject"; readonly id: number }
  /** `approve` / `reject` with no id: a usage line, never a fact. */
  | { readonly kind: "usage"; readonly verb: "approve" | "reject" };

/**
 * What follows `learn`. `pending`, `approve <id>` and `reject <id>` are the
 * owner's subcommands; anything else is a fact, so "approve of the new
 * process" is still teachable. Only the exact shapes are subcommands, which is
 * also what lets a non-owner be refused them instead of saving "approve 3".
 */
export const parseLearnArgs = (rest: string): LearnArgs => {
  const text = rest.trim();
  const words = text.split(/\s+/).filter(Boolean);
  const verb = (words[0] ?? "").toLowerCase();
  if (words.length === 1 && verb === "pending") return { kind: "pending" };
  if (verb === "approve" || verb === "reject") {
    if (words.length === 1) return { kind: "usage", verb };
    const id = /^#?(\d+)$/.exec(words[1] ?? "");
    if (words.length === 2 && id) return { kind: verb, id: Number(id[1]) };
  }
  return { kind: "fact", text };
};

/** The line of the approval DM that shows the fact: a press counts only while the pressed message still shows it. */
export const approvalCore = (content: string): string => `> ${escapeForSlack(oneLine(content))}`;

const whoAsked = (by: string): string => (by === AGENT_SOURCE || !by ? "one of my turns" : `<@${by}>`);

/** The DM the owner decides on. The fact is escaped, so it cannot render a link or a mention. */
export const approvalText = (id: number, content: string, by: string): string =>
  [
    `🧠 ${whoAsked(by)} wants me to remember this (learning #${id}). It is NOT part of my memory until you approve it:`,
    approvalCore(content),
    "Approve adds it to what I carry into every reply, in every channel. Reject discards it.",
  ].join("\n");

export const settledText = (kind: "approved" | "rejected", id: number, content: string, by: string): string =>
  `${kind === "approved" ? "✅" : "❌"} learning #${id} ${kind} by <@${by}>\n${approvalCore(content)}`;

/** What the typed `learn` says back when the fact is parked for the owner. */
export const pendingReply = (id: number, prefix: string): string =>
  `Saved as pending (#${id}). It is NOT part of my memory yet - the owner has to approve it first (\`${prefix} learn approve ${id}\`, or the buttons in their DM).`;

/**
 * What the API tells the agent that posted a learning. The agent reads this
 * and relays it, so it says plainly that nothing was saved yet.
 */
export const pendingApiMessage = (id: number): string =>
  `Pending owner approval (#${id}). This is NOT saved yet and changes nothing in any reply until the owner approves it. Do not tell anyone you saved it: say it is waiting for the owner's approval.`;

/** Why a decision, typed or pressed, did not go through. */
export type DecisionRefusal = "not-owner" | "from-turn" | "unknown" | "decided" | "forged";

export const refusalText = (r: DecisionRefusal, id?: number): string =>
  r === "not-owner"
    ? "Only the owner can approve, reject or list pending learnings."
    : r === "from-turn"
      ? "Approving or rejecting a learning is the owner's own typed line or button, never something I run for myself."
      : r === "decided"
        ? `Learning #${id} was already answered.`
        : r === "forged"
          ? "That button is not on the approval DM I posted for this learning, so it changed nothing."
          : `I have no pending learning #${id}. \`learn pending\` lists them.`;
