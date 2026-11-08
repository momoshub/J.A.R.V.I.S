/** Long host-login errands: close, note, read, investigate, fanout, ticket. */

import { notePrompt } from "../../domain/notePrompt.ts";
import { closePrompt } from "../../domain/closePrompt.ts";
import {
  canRaiseTickets,
  describeRepoScope,
  parseRepoScope,
  ticketPrompt,
  type TicketSources,
} from "../../domain/ticketPrompt.ts";
import { logSourceOrder } from "../../domain/investigation.ts";
import { investigatePrompt } from "../../domain/investigatePrompt.ts";
import { fanoutPrompt } from "../../domain/fanoutPrompt.ts";
import { readPrompt } from "../../domain/readPrompt.ts";
import { isAuthFailure } from "../../domain/threadSession.ts";
import type { UserRole } from "../../domain/types.ts";
import { parseNoteArgs } from "../../domain/noteTarget.ts";
import { SETTING_KEYS } from "../../infrastructure/db/settingsRepo.ts";
import { type CommandDeps, type CommandDef, RANK, roleOf, botNameOf } from "./shared.ts";

/** a ticket reads the SOP, the thread and the code, and may open a PR. */
const TICKET_TIMEOUT_MS = 900_000;

/** Publishing reads a file and builds a page; it is not a research task. */
const NOTE_TIMEOUT_MS = 300_000;

/** Closing reads the page and the tracker schema, then sets one property. */
const CLOSE_TIMEOUT_MS = 300_000;

/** an investigation walks logs, RUM and traces across environments. */
const INVESTIGATE_TIMEOUT_MS = 900_000;

/** a fanout waits on several agents doing real coding work. */
const FANOUT_TIMEOUT_MS = 2_700_000;

/** reading a conversation is bounded work, but a busy channel is a lot of it. */
const READ_TIMEOUT_MS = 600_000;

/**
 * Lowest role that may run `read`. Defaults to admin: it borrows the host
 * human's Slack and Notion access, so this is a trust decision, not a detail.
 */
const readFloorOf = (deps: CommandDeps): UserRole =>
  roleOf(deps.settings?.get(SETTING_KEYS.readMinRole)?.trim().toLowerCase()) ?? "admin";

export const ERRANDS_COMMANDS: readonly CommandDef[] = [
  {
    name: "close",
    aliases: ["resolve"],
    // A tool, like `note`: the brain closes a ticket mid-job and carries on.
    quiet: true,
    // Closing someone's ticket in the team tracker is an admin act. It is one
    // reversible property, which is why it is not owner-only.
    minRole: "admin",
    usage: "<ticket url or id> <why>",
    summary: "close a ticket in the tracker, recording who decided and why",
    run: async (ctx) => {
      const { deps, actor, args, rest, prefix, reply, channelId } = ctx;
      const ref = (args[0] ?? "").trim();
      const tracker = deps.settings?.get(SETTING_KEYS.ticketTracker)?.trim() || "";
      if (!ref) return `Close what? \`${prefix} close <ticket url or id> <why>\``;
      if (!tracker) return `No ticket tracker is configured, so I do not know which pages are ours to close.`;
      const why = rest.slice(rest.indexOf(ref) + ref.length).trim();
      if (!why) return `Why is it being closed? \`${prefix} close ${ref} <why>\` - a close with no reason is the same as one by accident.`;
      if (!deps.llm) return "My brain is not wired up right now.";

      const full = deps.toolPolicy?.("owner") ?? { skipPermissions: true };
      const name = botNameOf(deps);
      const params = {
        system: closePrompt({ ref, why, tracker, askedBy: actor.slackId }, name),
        messages: [{ role: "user" as const, content: `close ${ref}: ${why}` }],
        assistantName: name,
        policy: { ...full, timeoutMs: CLOSE_TIMEOUT_MS },
        // The tracker lives behind the account's Notion connector, which a
        // setup token does not carry.
        useHostLogin: true,
        bill: { actor: actor.slackId, kind: "close", channel: channelId, threadTs: ctx.threadTs },
      };

      if (!reply) {
        const out = await deps.llm.complete(params);
        return out.trim() || "I could not close that one.";
      }
      await reply(`🗂️ closing ${ref} for <@${actor.slackId}>`);
      let out = "";
      try {
        out = deps.llm.stream ? await deps.llm.stream(params, () => {}) : await deps.llm.complete(params);
      } catch (err) {
        if (!isAuthFailure(err)) throw err;
        await reply(
          "🔑 I could not close it - the login on my host has lapsed, and the tracker comes with it. Someone with access to the machine needs to run `claude` there and sign in again.",
        );
        return "";
      }
      await reply(out.trim() || "I could not close that one.");
      return "";
    },
  },
  {
    name: "note",
    aliases: ["publish"],
    // A tool, like `read`: the brain publishes mid-task and carries on with the
    // url. The counterpart to reading, and the reason this exists at all - the
    // bot used to finish a twenty minute job and tell someone to paste it in.
    quiet: true,
    minRole: "pal",
    usage: "<file> [title | <notion url> | --append <notion url>] | --comment <notion url> <text> | --edit-comment <notion url> <text> | parent <notion url> | access <role>",
    summary: "publish a document into Notion, update a page that is already there, or comment on one and edit that comment",
    run: async (ctx) => {
      const { deps, actor, args, prefix, reply, channelId } = ctx;
      const first = (args[0] ?? "").trim();
      const parent = deps.settings?.get(SETTING_KEYS.notionParent)?.trim() || "";
      const floor = roleOf(deps.settings?.get(SETTING_KEYS.noteMinRole)?.trim().toLowerCase() ?? "") ?? "admin";

      if (first.toLowerCase() === "parent") {
        const url = (args[1] ?? "").trim();
        if (!url) return `Where should pages go? \`${prefix} note parent <notion url>\` (now: ${parent || "*not set*"})`;
        if (RANK[actor.role] < RANK.admin) return "Only admins can set where my pages go.";
        deps.settings?.set(SETTING_KEYS.notionParent, url);
        return `New pages will go under ${url}.`;
      }

      if (first.toLowerCase() === "access") {
        const want = roleOf((args[1] ?? "").toLowerCase());
        if (!want) return `Which role? \`${prefix} note access <pal|executer|admin|owner>\` (now: *${floor}*)`;
        if (RANK[actor.role] < RANK.admin) return "Only admins can change who may publish.";
        deps.settings?.set(SETTING_KEYS.noteMinRole, want);
        return `\`note\` is now open to *${want}* and above. It writes under my host's Notion identity, so anyone at that level publishes as them.`;
      }

      if (RANK[actor.role] < RANK[floor]) {
        return `I cannot publish that myself - \`note\` writes with my host's Notion identity and is limited to *${floor}* and above. Ask someone at that level to run \`${prefix} note <file>\`.`;
      }
      if (!first) return `Publish what? \`${prefix} note <file> [title]\``;
      // Creating needs somewhere to put it; updating already knows where it is
      // going, so a missing parent must not stand in the way of an edit.
      const aim = parseNoteArgs(args);
      if (!aim.ok) return `${aim.error}. \`${prefix} note <file> [title]\`, \`${prefix} note <file> <notion url>\` to update that page, \`${prefix} note --comment <notion url> <text>\` to comment on it, or \`${prefix} note --edit-comment <notion url> <text>\` to rewrite your last comment there.`;
      if (aim.mode === "create" && !parent) {
        return `I have nowhere to put it - no Notion parent is configured. An admin can set one: \`${prefix} note parent <notion url>\``;
      }
      if (!deps.llm) return "My brain is not wired up right now.";

      const title = aim.title;
      const full = deps.toolPolicy?.("owner") ?? { skipPermissions: true };
      const name = botNameOf(deps);
      const params = {
        system: notePrompt(
          { path: aim.path, title, parent, askedBy: actor.slackId, mode: aim.mode, target: aim.target, text: aim.text },
          name,
        ),
        messages: [
          {
            role: "user" as const,
            content:
              aim.mode === "create"
                ? `publish ${aim.path}${title ? ` as "${title}"` : ""}`
                : aim.mode === "comment" || aim.mode === "edit-comment"
                  ? `${aim.mode === "comment" ? "comment on" : "edit my comment on"} ${aim.target}${aim.text ? `: ${aim.text}` : ` from ${aim.path}`}`
                  : `${aim.mode === "append" ? "append" : "update"} ${aim.target} from ${aim.path}`,
          },
        ],
        assistantName: name,
        policy: { ...full, timeoutMs: NOTE_TIMEOUT_MS },
        // Notion lives with the host's interactive login; a setup token carries
        // no connectors at all, so this is the only credential that can write.
        useHostLogin: true,
        bill: { actor: actor.slackId, kind: "note", channel: channelId, threadTs: ctx.threadTs },
      };

      if (!reply) {
        const out = await deps.llm.complete(params);
        return out.trim() || "I could not publish that one.";
      }
      await reply(
        aim.mode === "create"
          ? `📝 publishing that to Notion for <@${actor.slackId}>`
          : `📝 ${aim.mode === "append" ? "adding that to" : aim.mode === "comment" ? "commenting on" : aim.mode === "edit-comment" ? "editing a comment on" : "updating"} ${aim.target} for <@${actor.slackId}>`,
      );
      let out = "";
      try {
        out = deps.llm.stream ? await deps.llm.stream(params, () => {}) : await deps.llm.complete(params);
      } catch (err) {
        if (!isAuthFailure(err)) throw err;
        await reply(
          "🔑 I could not publish it - the login on my host has lapsed, and Notion comes with it. Someone with access to the machine needs to run `claude` there and sign in again.",
        );
        return "";
      }
      await reply(out.trim() || "I could not publish that one.");
      return "";
    },
  },
  {
    name: "read",
    aliases: ["summarise", "summarize", "catchup"],
    // A step inside a larger job, not an announcement. When the brain reaches
    // for it mid-task the content comes back to it; posting the document into
    // the thread as well is the noise that made this feel like a dump.
    quiet: true,
    // The entry gate is `pal` so the command is reachable; the real threshold is
    // configurable and checked below. It reads with the authorising human's
    // access, so whoever may run it can read anything that person can - which
    // is a decision for whoever owns this instance, not a constant.
    minRole: "pal",
    usage: "<link> [what you want from it] | access <role>",
    summary: "read something my own token cannot - a Notion page, a channel I am not in - through the account's connectors",
    run: async (ctx) => {
      const { deps, actor, channelId, threadTs, args, rest, prefix, reply } = ctx;
      const target = (args[0] ?? "").trim();

      // Who may borrow the host's access, as configuration rather than a
      // constant: owner-only made the command useless for the case it exists
      // for - a colleague asking it to follow a document the team shares.
      const floor = readFloorOf(deps);
      if (target.toLowerCase() === "access") {
        const want = roleOf((args[1] ?? "").toLowerCase());
        if (!want) return `Which role? \`${prefix} read access <pal|executer|admin|owner>\` (now: *${floor}*)`;
        if (RANK[actor.role] < RANK.admin) return "Only admins can change who may use `read`.";
        deps.settings?.set(SETTING_KEYS.readMinRole, want);
        return `\`read\` is now open to *${want}* and above. It borrows my host's Slack and Notion access, so anyone at that level can have me read anything that account can see.`;
      }

      if (RANK[actor.role] < RANK[floor]) {
        return `I cannot open that one myself - \`read\` borrows my host's access and is limited to *${floor}* and above. Ask someone at that level to run \`${prefix} read <link>\`, or paste the content here and I will work from that.`;
      }

      if (!target) return `Read what? \`${prefix} read <link>\``;
      if (!deps.llm) return "My brain is not wired up right now.";

      const note = rest.slice(rest.indexOf(target) + target.length).trim();
      const full = deps.toolPolicy?.("owner") ?? { skipPermissions: true };
      const name = botNameOf(deps);
      const params = {
        system: readPrompt({ target, note, channelId, threadTs, askedBy: actor.slackId, artifactScript: deps.artifactScript }, name),
        messages: [{ role: "user" as const, content: `read ${target}${note ? `\n\n${note}` : ""}` }],
        assistantName: name,
        policy: { ...full, timeoutMs: READ_TIMEOUT_MS },
        // The connector lives with the host's interactive login; a setup token
        // carries none, so this is the only credential that can see it.
        useHostLogin: true,
        bill: { actor: actor.slackId, kind: "read", channel: channelId, threadTs },
      };

      if (!reply) {
        const out = await deps.llm.complete(params);
        return out.trim() || "I could not read that one.";
      }

      await reply(`👀 reading that for <@${actor.slackId}>`);
      let out = "";
      try {
        out = deps.llm.stream
          ? await deps.llm.stream(params, () => {})
          : await deps.llm.complete(params);
      } catch (err) {
        if (!isAuthFailure(err)) throw err;
        await reply(
          "🔑 I could not read it - the login on my host has lapsed, and the Slack connector comes with it. Someone with access to the machine needs to run `claude` there and sign in again.",
        );
        return "";
      }
      await reply(out.trim() || "I could not read that one.");
      return "";
    },
  },
  {
    name: "investigate",
    aliases: ["inv", "rca"],
    // A full-access run on the host login, with every connector loaded.
    minRole: "executer",
    usage: "<what to look into>",
    summary: "dig through logs, RUM and traces for the cause - runs with the connectors loaded",
    run: async (ctx) => {
      const { deps, actor, channelId, threadTs, rest, prefix, reply } = ctx;
      const question = rest.trim();
      if (!question) return `What should I look into? \`${prefix} investigate <what happened>\``;
      if (!deps.llm) return "My brain is not wired up right now.";

      const order = logSourceOrder(deps.settings?.get(SETTING_KEYS.logSources));
      if (order.length === 0) {
        return `No log sources are configured, so there is nowhere for me to look. An admin can set them: \`${prefix} logsource grafana,datadog\``;
      }

      // A preset full-access task, and - like a ticket - one that runs on the
      // HOST login rather than any setup token. Datadog (and RUM in particular)
      // is reachable only through the account's connectors, which a setup token
      // carries none of; that credential split is the whole reason this is its
      // own command instead of something chat does inline.
      const full = deps.toolPolicy?.("owner") ?? { skipPermissions: true };
      const name = botNameOf(deps);
      const params = {
        system: investigatePrompt(question, name, order, deps.grafanaGetScript, {
          channelId,
          threadTs,
          askedBy: actor.slackId,
        }),
        messages: [{ role: "user" as const, content: question }],
        assistantName: name,
        policy: { ...full, timeoutMs: INVESTIGATE_TIMEOUT_MS },
        useHostLogin: true,
        bill: { actor: actor.slackId, kind: "investigate", channel: channelId, threadTs },
      };

      if (!reply) {
        const out = await deps.llm.complete(params);
        return out.trim() || "I could not get to the bottom of that one.";
      }

      await reply(`🔎 investigating for <@${actor.slackId}>`);
      let out = "";
      try {
        if (deps.llm.stream) {
          const seen = new Set<string>();
          const announce = (line: string) => {
            if (seen.has(line)) return;
            seen.add(line);
            void reply(line);
          };
          out = await deps.llm.stream(params, (ev) => {
            if (ev.type !== "tool" || ev.status !== "complete") return;
            const ran = (ev.command ?? ev.title).toLowerCase();
            // Which source actually answered is the thing people most want to
            // know mid-run, and the thing a report most often blurs.
            if (/mcp__.*datadog.*rum/.test(ran)) announce("📊 reading RUM in Datadog");
            else if (/mcp__.*datadog/.test(ran)) announce("🐶 querying Datadog");
            if (/gcx |grafana-get\.sh/.test(ran)) announce("📈 querying Grafana");
          });
        } else {
          out = await deps.llm.complete(params);
        }
      } catch (err) {
        if (!isAuthFailure(err)) throw err;
        await reply(
          "🔑 I could not investigate - the login on my host has lapsed, and the connectors come with it. Someone with access to the machine needs to run `claude` there and sign in again.",
        );
        return "";
      }
      await reply(out.trim() || "I could not get to the bottom of that one.");
      return "";
    },
  },
  {
    name: "fanout",
    aliases: ["orca"],
    // the workers are Claude Code sessions Orca starts on the host, billed to
    // whoever is signed in there, so this is not a pal-level button
    minRole: "admin",
    usage: "<job to split across agents>",
    summary: "split a coding job across parallel Claude Code agents in Orca, one worktree each",
    run: async (ctx) => {
      const { deps, actor, channelId, threadTs, rest, prefix, reply } = ctx;
      const task = rest.trim();
      if (!task) return `What should the agents work on? \`${prefix} fanout <job>\``;
      if (!deps.llm) return "My brain is not wired up right now.";

      const full = deps.toolPolicy?.("owner") ?? { skipPermissions: true };
      const name = botNameOf(deps);
      const params = {
        system: fanoutPrompt(task, name, { channelId, threadTs, askedBy: actor.slackId }),
        messages: [{ role: "user" as const, content: task }],
        assistantName: name,
        policy: { ...full, timeoutMs: FANOUT_TIMEOUT_MS },
        bill: { actor: actor.slackId, kind: "fanout", channel: channelId, threadTs },
      };

      if (!reply) {
        const out = await deps.llm.complete(params);
        return out.trim() || "The agents came back with nothing to report.";
      }

      await reply(`🐋 splitting that across agents in Orca for <@${actor.slackId}>`);
      let out = "";
      if (deps.llm.stream) {
        const started = new Set<string>();
        out = await deps.llm.stream(params, (ev) => {
          if (ev.type !== "tool" || ev.status !== "complete") return;
          const ran = ev.command ?? ev.title;
          const slug = /orca worktree create\b.*?--name\s+['"]?([\w.-]+)/.exec(ran)?.[1];
          if (!slug || started.has(slug)) return;
          started.add(slug);
          void reply(`🤖 started worker \`${slug}\``);
        });
      } else {
        out = await deps.llm.complete(params);
      }
      await reply(out.trim() || "The agents came back with nothing to report.");
      return "";
    },
  },
  {
    name: "ticket",
    aliases: ["bug", "raise"],
    minRole: "pal",
    usage: "<what is wrong> | config [key] [value]",
    summary: "raise a properly written, correctly routed ticket",
    run: async (ctx) => {
      const { deps, actor, channelId, threadTs, args, rest, prefix, reply } = ctx;
      const get = (k: string) => deps.settings?.get(k)?.trim() || undefined;
      const sources: TicketSources = {
        tracker: get(SETTING_KEYS.ticketTracker),
        sop: get(SETTING_KEYS.ticketSop),
        pods: get(SETTING_KEYS.ticketPods),
        repoScope: parseRepoScope(get(SETTING_KEYS.ticketRepos)),
      };

      // `ticket config ...` - where the team keeps its own rules.
      if ((args[0] ?? "").toLowerCase() === "config") {
        const show = () =>
          [
            `tracker: ${sources.tracker ?? "*not set*"}`,
            `sop:     ${sources.sop ?? "*not set*"}`,
            `pods:    ${sources.pods ?? "*not set*"}`,
            `repos:   ${describeRepoScope(sources.repoScope ?? { orgs: [], repos: [] })}`,
          ].join("\n");
        if (args.length === 1) return show();
        if (RANK[actor.role] < RANK.admin) return "Only admins can change the ticket configuration.";
        const key = (args[1] ?? "").toLowerCase();
        const value = rest.slice(rest.indexOf(args[1] ?? "") + (args[1] ?? "").length).trim();
        const target = { tracker: SETTING_KEYS.ticketTracker, sop: SETTING_KEYS.ticketSop, pods: SETTING_KEYS.ticketPods, repos: SETTING_KEYS.ticketRepos }[key];
        if (!target) return `Which one? \`${prefix} ticket config <tracker|sop|pods|repos> <value>\``;
        deps.settings?.set(target, value === "default" || value === "none" ? "" : value);
        return `Set *${key}*.\n${show().replace(value, value)}`;
      }

      const report = rest.trim();
      if (!report) return `What is wrong? \`${prefix} ticket <what happened>\``;
      if (!canRaiseTickets(sources)) {
        return `No ticket tracker is configured, so I have nowhere to put it. An admin can set one: \`${prefix} ticket config tracker <notion url>\``;
      }
      if (!deps.llm) return "My brain is not wired up right now.";

      // A preset task: full access regardless of who asked, and a long timeout -
      // it reads the SOP, the thread, the code, and may open a PR.
      const full = deps.toolPolicy?.("owner") ?? { skipPermissions: true };
      const policy = { ...full, timeoutMs: TICKET_TIMEOUT_MS };
      const name = botNameOf(deps);
      const params = {
        system: ticketPrompt(report, name, sources, { channelId, threadTs, reporter: actor.slackId }, await deps.github?.whoami()),
        messages: [{ role: "user" as const, content: report }],
        assistantName: name,
        policy,
        // Not the caller's token, and not the bot's: a ticket has to read Notion,
        // and a `claude setup-token` credential carries no claude.ai connector
        // authorisation at all (verified: zero mcp__ tools under one). Only the
        // host's interactive login has the connectors, so this one task uses it.
        useHostLogin: true,
        bill: { actor: actor.slackId, kind: "ticket", channel: channelId, threadTs },
      };

      if (!reply) {
        const out = await deps.llm.complete(params);
        return out.trim() || "I could not raise that one.";
      }

      await reply(`🎫 raising a ticket for <@${actor.slackId}>`);
      let out = "";
      try {
        if (deps.llm.stream) {
          const seen = new Set<string>();
          const announce = (line: string) => {
            if (seen.has(line)) return;
            seen.add(line);
            void reply(line);
          };
          out = await deps.llm.stream(params, (ev) => {
            if (ev.type !== "tool" || ev.status !== "complete") return;
            const ran = (ev.command ?? ev.title).toLowerCase();
            if (/notion-create-pages/.test(ran)) announce("📝 created the ticket");
            if (/gh pr create\b/.test(ran)) announce("🔧 opened a PR for it");
            if (/gh pr edit[^\n]*--add-reviewer/.test(ran)) announce("👀 asked for a review");
          });
        } else {
          out = await deps.llm.complete(params);
        }
      } catch (err) {
        // The known failure mode of running on the host session: it lapsed. Say
        // that, because nothing in the thread would otherwise suggest a login.
        if (!isAuthFailure(err)) throw err;
        await reply(
          "🔑 I could not raise that one - the login on my host has lapsed, and a ticket needs it for Notion. Someone with access to the machine needs to run `claude` there and sign in again.",
        );
        return "";
      }
      await reply(out.trim() || "I could not raise that one.");
      return "";
    },
  },
];
