/** Learned facts: learn, learnings, relearn, unlearn. */

import { isBlank } from "../../domain/adapter.ts";
import { AGENT_SOURCE, parseLearnArgs, pendingReply, refusalText } from "../../domain/learning.ts";
import { decideLearning, proposeLearning, rewordLearning, saveActive } from "../learningApproval.ts";
import { type CommandDef, adapterDepsOf } from "./shared.ts";

export const LEARNINGS_COMMANDS: readonly CommandDef[] = [
  {
    name: "learn",
    minRole: "executer",
    usage: "<fact>|pending|approve <id>|reject <id>",
    summary: "teach me a durable fact (the owner's is saved, anyone else's waits for the owner's approval)",
    run: async ({ deps, actor, rest, prefix, fromBrainRun }) => {
      const la = deps.learningApproval;
      if (!la) return "Learnings are not available.";
      const owner = actor.role === "owner";
      const args = parseLearnArgs(rest);

      // The owner's side of it. A member typing these is refused rather than
      // saving "approve 3" as a fact, and so is the brain: deciding is the
      // owner's own typed line or button, never something a turn runs for itself.
      if (args.kind === "pending") {
        if (!owner) return refusalText("not-owner");
        const waiting = la.learnings.pending();
        if (waiting.length === 0) return "No learnings are waiting for approval.";
        return [
          ...waiting.map((l) => `- #${l.id} (${l.createdBy === AGENT_SOURCE ? "from a turn" : `<@${l.createdBy}>`}) ${l.content}`),
          `_\`${prefix} learn approve <id>\` or \`${prefix} learn reject <id>\`_`,
        ].join("\n");
      }
      if (args.kind === "usage") {
        return owner ? `Which one? \`${prefix} learn ${args.verb} <id>\` (see \`${prefix} learn pending\`)` : refusalText("not-owner");
      }
      if (args.kind === "approve" || args.kind === "reject") {
        if (!owner) return refusalText("not-owner");
        if (fromBrainRun) return refusalText("from-turn");
        const r = await decideLearning(la, args.id, args.kind, actor.slackId);
        if (r.kind === "refused") return refusalText(r.why, args.id);
        if (r.kind === "failed") return `I could not keep that, so it is still pending:\n${r.violations.map((v) => `- ${v}`).join("\n")}`;
        if (r.kind === "rejected") return `Rejected #${args.id}. It will never be part of my memory.`;
        const nag =
          r.warnings.length > 0
            ? `\n:warning: my always-on memory is over budget - \`${prefix} adapter refine\` will tidy it.`
            : "";
        return `Approved #${args.id}. I will keep that in mind.${nag}`;
      }

      const fact = args.text;
      if (!fact) return `Teach me something: \`${prefix} learn <fact>\``;

      // Only the owner's own typing is saved active. A member's line, and any
      // `learn` the brain runs for itself (even in the owner's turn: the turn
      // may have read something hostile), wait for the owner's approval.
      if (owner && !fromBrainRun) {
        // Teaching stays instant and is never refused for size - the moment
        // "remember this" can fail, people stop telling me things - so the
        // adapter's budget is reported here rather than enforced.
        const saved = saveActive(la, fact, actor.slackId);
        if (!saved.ok) return `I could not keep that:\n${saved.violations.map((v) => `- ${v}`).join("\n")}`;
        const nag =
          saved.warnings.length > 0
            ? `\n:warning: my always-on memory is over budget - \`${prefix} adapter refine\` will tidy it.`
            : "";
        return `Learned it${saved.id === undefined ? "" : ` (#${saved.id})`}. I will keep that in mind.${nag}`;
      }
      const proposed = await proposeLearning(la, fact, fromBrainRun ? AGENT_SOURCE : actor.slackId);
      return proposed.ok ? pendingReply(proposed.learning.id, prefix) : proposed.error;
    },
  },
  {
    name: "learnings",
    minRole: "executer",
    usage: "",
    summary: "list what I have learned",
    run: ({ deps, actor, prefix }) => {
      // Only the owner can decide them, so only the owner is told.
      const waiting = actor.role === "owner" ? (deps.learningApproval?.learnings.pending().length ?? 0) : 0;
      const nudge = waiting > 0 ? `\n\n_${waiting} waiting for your approval: \`${prefix} learn pending\`_` : "";
      const a = adapterDepsOf(deps);
      if (a) {
        const adapter = a.store.load();
        const blocks = [
          isBlank(adapter.policy) ? "" : `*Policy*\n${adapter.policy}`,
          isBlank(adapter.notes) ? "" : `*Notes*\n${adapter.notes}`,
          adapter.skills.length === 0
            ? ""
            : `*In depth*\n${adapter.skills.map((sk) => `- ${sk.name}: ${sk.description}`).join("\n")}`,
          adapter.people.size + adapter.channels.size === 0
            ? ""
            : `_plus ${adapter.people.size} people and ${adapter.channels.size} channels I keep separate notes on_`,
        ].filter(Boolean);
        return blocks.length === 0
          ? `I have not learned anything yet.${nudge}`
          : `${blocks.join("\n\n")}\n\n_\`${prefix} adapter\` for the numbers_${nudge}`;
      }
      if (!deps.learnings) return "Learnings are not available.";
      const list = deps.learnings.list();
      if (list.length === 0) return `I have not learned anything yet.${nudge}`;
      return `${list.map((l) => `- #${l.id} ${l.content}`).join("\n")}${nudge}`;
    },
  },
  {
    name: "relearn",
    aliases: ["edit-learning"],
    minRole: "executer",
    usage: "<id> <new wording>",
    summary: "reword something I have learned",
    run: async ({ deps, actor, args, rest, prefix, fromBrainRun }) => {
      if (adapterDepsOf(deps)) {
        return `My memory is an adapter now, so there are no numbered learnings to edit. Use \`${prefix} adapter refine\` to curate it, or \`${prefix} adapter revert <id>\` to undo a pass.`;
      }
      if (!deps.learnings || !deps.learningApproval) return "Learnings are not available.";
      const id = Number(args[0]);
      if (!Number.isInteger(id)) return `Which one? \`${prefix} relearn <id> <new wording>\` (see \`${prefix} learnings\`)`;
      const content = rest.slice(String(args[0]).length).trim();
      if (!content) return `What should it say? \`${prefix} relearn ${id} <new wording>\``;
      // Any status: the owner may reword one that waits for them before approving it.
      const before = deps.learnings.get(id);
      if (!before) return `I have no learning #${id}. Check \`${prefix} learnings\` or \`${prefix} learn pending\`.`;
      // Rewording is a write like any other: only the owner's own typing keeps it live.
      const r = await rewordLearning(deps.learningApproval, id, content, {
        slackId: fromBrainRun ? "" : actor.slackId,
        owner: actor.role === "owner" && !fromBrainRun,
      });
      if (!r.ok) return r.error;
      return r.pending
        ? `Reworded #${id}, but it is pending again: the owner has to approve the new wording (\`${prefix} learn approve ${id}\`) and until then it is not part of my memory.\n~${before.content}~\n${content}`
        : `Updated #${id}.\n~${before.content}~\n${content}`;
    },
  },
  {
    name: "unlearn",
    minRole: "executer",
    usage: "<id>",
    summary: "make me forget a learning",
    run: ({ deps, args, prefix }) => {
      if (adapterDepsOf(deps)) {
        return `My memory is an adapter now, so there are no numbered learnings to edit. Use \`${prefix} adapter refine\` to curate it, or \`${prefix} adapter revert <id>\` to undo a pass.`;
      }
      if (!deps.learnings) return "Learnings are not available.";
      const id = Number(args[0]);
      if (!Number.isInteger(id)) return `Which one? \`${prefix} unlearn <id>\` (see \`${prefix} learnings\`)`;
      deps.learnings.remove(id);
      return `Forgotten learning #${id}.`;
    },
  },
];
