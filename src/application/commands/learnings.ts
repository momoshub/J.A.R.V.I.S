/** Learned facts: learn, learnings, relearn, unlearn. */

import { isBlank } from "../../domain/adapter.ts";
import { rememberFact } from "../adapterMemory.ts";
import { type CommandDef, adapterDepsOf } from "./shared.ts";

export const LEARNINGS_COMMANDS: readonly CommandDef[] = [
  {
    name: "learn",
    minRole: "executer",
    usage: "<fact>",
    summary: "teach me a durable fact",
    run: ({ deps, actor, rest, prefix }) => {
      const fact = rest.trim();
      if (!fact) return `Teach me something: \`${prefix} learn <fact>\``;

      // With an adapter, the fact lands in the inbox heading and a refine pass
      // files it. Teaching stays instant and is never refused - the moment
      // "remember this" can fail, people stop telling me things - so the
      // budget is reported here rather than enforced.
      const a = adapterDepsOf(deps);
      if (a) {
        const result = rememberFact(a, fact, { kind: "global" }, actor.slackId);
        if (!result.ok) return `I could not keep that:\n${result.violations.map((v) => `- ${v}`).join("\n")}`;
        const nag =
          result.warnings.length > 0
            ? `\n:warning: my always-on memory is over budget - \`${prefix} adapter refine\` will tidy it.`
            : "";
        return `Learned it. I will keep that in mind.${nag}`;
      }

      if (!deps.learnings) return "Learnings are not available.";
      const l = deps.learnings.add(fact, actor.slackId, deps.clock());
      return `Learned it (#${l.id}). I will keep that in mind.`;
    },
  },
  {
    name: "learnings",
    minRole: "executer",
    usage: "",
    summary: "list what I have learned",
    run: ({ deps, prefix }) => {
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
          ? "I have not learned anything yet."
          : `${blocks.join("\n\n")}\n\n_\`${prefix} adapter\` for the numbers_`;
      }
      if (!deps.learnings) return "Learnings are not available.";
      const list = deps.learnings.list();
      if (list.length === 0) return "I have not learned anything yet.";
      return list.map((l) => `- #${l.id} ${l.content}`).join("\n");
    },
  },
  {
    name: "relearn",
    aliases: ["edit-learning"],
    minRole: "executer",
    usage: "<id> <new wording>",
    summary: "reword something I have learned",
    run: ({ deps, args, rest, prefix }) => {
      if (adapterDepsOf(deps)) {
        return `My memory is an adapter now, so there are no numbered learnings to edit. Use \`${prefix} adapter refine\` to curate it, or \`${prefix} adapter revert <id>\` to undo a pass.`;
      }
      if (!deps.learnings) return "Learnings are not available.";
      const id = Number(args[0]);
      if (!Number.isInteger(id)) return `Which one? \`${prefix} relearn <id> <new wording>\` (see \`${prefix} learnings\`)`;
      const content = rest.slice(String(args[0]).length).trim();
      if (!content) return `What should it say? \`${prefix} relearn ${id} <new wording>\``;
      const before = deps.learnings.list().find((l) => l.id === id);
      if (!before) return `I have no learning #${id}. Check \`${prefix} learnings\`.`;
      deps.learnings.update(id, content);
      return `Updated #${id}.\n~${before.content}~\n${content}`;
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
