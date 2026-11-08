/** The adapter: skills and rules kept in the DB. */

import { refinePrompt } from "../../domain/refinePrompt.ts";
import { adapterRules, isBlank } from "../../domain/adapter.ts";
import { ALWAYS_ON_BUDGET, describeCheck } from "../../domain/adapterCheck.ts";
import { adapterStatus, commitAdapter, migrateLearnings, revertAdapter } from "../adapterMemory.ts";
import { type CommandDef, adapterDepsOf, botNameOf } from "./shared.ts";

/** A refine pass reads every file and rewrites most of them. */
const REFINE_TIMEOUT_MS = 900_000;

export const ADAPTER_COMMANDS: readonly CommandDef[] = [
  {
    name: "adapter",
    aliases: ["memory"],
    minRole: "admin",
    usage: "[status|check|history|refine [note]|revert <id>|export|import <dir>|migrate]",
    summary: "inspect and curate what I remember",
    run: async (ctx) => {
      const { deps, actor, args, rest, prefix, reply, channelId } = ctx;
      const a = adapterDepsOf(deps);
      if (!a) return "No memory adapter is configured, so I am still on the flat learnings list.";
      const sub = (args[0] ?? "status").toLowerCase();

      if (sub === "status") return adapterStatus(a);

      if (sub === "check") {
        const files = a.store.files();
        const result = commitAdapter(a, files, { reason: "check", actor: actor.slackId });
        // A check is a dry run: committing the files it already has changes
        // nothing on disk, and the gate is the only thing being asked.
        return result.ok
          ? `${describeCheck({ ok: true, violations: [] })}\n\n${adapterStatus(a)}`
          : `The adapter does NOT pass:\n${result.violations.map((v) => `- ${v}`).join("\n")}`;
      }

      if (sub === "history") {
        const list = a.revisions?.list(15) ?? [];
        if (list.length === 0) return "No revisions yet.";
        return list
          .map((r) => `- #${r.id} ${new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ")} ${r.reason}`)
          .join("\n");
      }

      if (sub === "revert") {
        const id = Number(args[1]);
        if (!Number.isInteger(id)) return `Which one? \`${prefix} adapter revert <id>\` (see \`${prefix} adapter history\`)`;
        const result = revertAdapter(a, id, actor.slackId);
        return result.ok
          ? `Reverted to #${id}${result.revision ? ` (now #${result.revision})` : ""}.\n\n${adapterStatus(a)}`
          : `Could not revert:\n${result.violations.map((v) => `- ${v}`).join("\n")}`;
      }

      if (sub === "migrate") {
        const list = deps.learnings?.list() ?? [];
        if (list.length === 0) return "The learnings list is empty - nothing to migrate.";
        const result = migrateLearnings(a, list.map((l) => l.content), actor.slackId, () => {
          // One store of memory, not two. The old rows are in the revision
          // this just wrote, and in git.
          for (const l of list) deps.learnings?.remove(l.id);
        });
        if (!result.ok) return `Could not migrate:\n${result.violations.map((v) => `- ${v}`).join("\n")}`;
        return [
          `Moved ${list.length} learnings into the adapter${result.revision ? ` (#${result.revision})` : ""} and emptied the old list.`,
          `They went in unsorted and unmerged, exactly as they were - revision #${result.revision ?? "?"} is the record.`,
          `Run \`${prefix} adapter refine\` to actually curate them.`,
          ...(result.warnings.length > 0 ? ["", ...result.warnings.map((w) => `:warning: ${w}`)] : []),
        ].join("\n");
      }

      // Memory lives in the database, so a hand edit (a new skill, a fixed
      // note) goes out to a copy and comes back through the same gate and
      // revision log a refine pass does. Editing the mirror changes nothing.
      if (sub === "export") {
        const dir = a.store.stage();
        return `Exported to \`${dir}\`. Edit it there, then \`${prefix} adapter import ${dir}\`.`;
      }

      if (sub === "import") {
        const dir = args[1];
        if (!dir) return `From where? \`${prefix} adapter import <dir>\` (start from \`${prefix} adapter export\`)`;
        const next = a.store.collect(dir);
        if (next.size === 0) return `Nothing to import in \`${dir}\`.`;
        const result = commitAdapter(a, next, { reason: `import by ${actor.slackId}`, actor: actor.slackId });
        if (!result.ok) return `Could not import:\n${result.violations.map((v) => `- ${v}`).join("\n")}`;
        a.store.discard(dir);
        return [
          `Imported${result.revision ? ` (#${result.revision})` : ""}.`,
          ...result.warnings.map((w) => `:warning: ${w}`),
          "",
          adapterStatus(a),
        ].join("\n");
      }

      if (sub !== "refine")
        return `Which one? \`${prefix} adapter [status|check|history|refine|revert <id>|export|import <dir>|migrate]\``;

      if (!deps.llm) return "My brain is not wired up right now.";
      const note = rest.slice(rest.toLowerCase().indexOf("refine") + "refine".length).trim();
      const adapter = a.store.load();
      const currentBytes = new TextEncoder().encode(
        [adapterRules(adapter), isBlank(adapter.notes) ? "" : adapter.notes].filter(Boolean).join("\n\n"),
      ).length;
      const budget = a.budget ?? ALWAYS_ON_BUDGET;

      // The pass edits a throwaway copy; what comes back is gated and
      // committed here. The model never writes the live adapter.
      const staging = a.store.stage();
      const name = botNameOf(deps);
      const full = deps.toolPolicy?.("owner") ?? { skipPermissions: true };
      const params = {
        system: refinePrompt({ currentBytes, budget, note: note || undefined }, name),
        messages: [{ role: "user" as const, content: note || "Curate my memory." }],
        assistantName: name,
        policy: { ...full, cwd: staging, timeoutMs: REFINE_TIMEOUT_MS },
        bill: { actor: actor.slackId, kind: "adapter", channel: channelId, threadTs: ctx.threadTs },
      };

      if (reply) await reply("🧹 going through what I remember");
      let out = "";
      try {
        out = deps.llm.stream && reply ? await deps.llm.stream(params, () => {}) : await deps.llm.complete(params);
        const next = a.store.collect(staging);
        if (next.size === 0) return "The pass came back with nothing, so I left my memory alone.";
        const result = commitAdapter(a, next, {
          reason: note ? `refine: ${note.slice(0, 100)}` : "refine",
          actor: actor.slackId,
          enforceBudget: true,
          enforceFixed: true,
        });
        if (!result.ok) {
          return [
            "That pass did not pass its own checks, so I kept what I had:",
            ...result.violations.map((v) => `- ${v}`),
          ].join("\n");
        }
        const summary = out.trim() || "Done.";
        const tail = `\n\n${adapterStatus(a)}\n_revision #${result.revision ?? "?"} - \`${prefix} adapter revert ${result.revision ?? ""}\` puts it back_`;
        if (reply) {
          await reply(summary + tail);
          return "";
        }
        return summary + tail;
      } finally {
        a.store.discard(staging);
      }
    },
  },
];
