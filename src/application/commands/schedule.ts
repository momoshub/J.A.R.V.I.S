/** Things that run later or on their own: follow, watch, remind, mindful. */

import { parseMessageLink } from "../../domain/slackLinks.ts";
import { builtinCheck, humanDuration, parseWatchArgs } from "../../domain/watch.ts";
import { formatWhen, humanLead, parseRemindArgs } from "../../domain/reminder.ts";
import {
  mindfulReport,
  teamFromPermalink,
  type LiveRun,
  type MindfulView,
} from "../../domain/mindful.ts";
import { type CommandDef, RANK, parseWindow } from "./shared.ts";

export const SCHEDULE_COMMANDS: readonly CommandDef[] = [
  {
    name: "follow",
    aliases: ["autoreply"],
    // It makes the bot speak in a room without being spoken to, which is a
    // standing decision about a shared space rather than a one-off reply.
    minRole: "executer",
    usage: "[<thread link>] | off [<thread link>] | list",
    summary: "keep up with a thread without being tagged in every message",
    run: ({ deps, actor, args, rest, prefix, threadTs, channelId }) => {
      if (!deps.follows) return "I cannot keep track of followed threads right now.";
      const sub = (args[0] ?? "").toLowerCase();

      if (sub === "list") {
        const all = deps.follows.list(30);
        if (all.length === 0) return "I am not following any thread I did not start.";
        return all
          .map((f) => `- <#${f.channelId}> \`${f.threadTs}\` - added by <@${f.addedBy}>`)
          .join("\n");
      }

      const off = sub === "off" || sub === "stop" || sub === "no";
      const linkArg = off ? (args[1] ?? "") : (args[0] ?? "");
      const ref = linkArg ? parseMessageLink(linkArg.replace(/^<|>$/g, "")) : undefined;
      if (linkArg && !ref) return `That is not a Slack thread link. \`${prefix} follow <thread link>\``;
      // A link wins; otherwise it is the thread this was typed in.
      const target = ref ?? (threadTs ? { channel: channelId, ts: threadTs } : undefined);
      if (!target) {
        return `Which thread? Run it in the thread, or \`${prefix} follow <thread link>\``;
      }

      if (off) {
        return deps.follows.remove(target.channel, target.ts, deps.clock())
          ? "stopped following that one - I will only answer there when tagged now 🫧"
          : "I was not following that thread.";
      }
      deps.follows.add(target.channel, target.ts, actor.slackId, deps.clock());
      void rest;
      return `following that thread now - I will read every message in it and answer when I actually have something, without being tagged. Most of the time that means staying quiet. \`${prefix} follow off\` to stop 👀`;
    },
  },
  {
    name: "watch",
    aliases: ["waitfor"],
    // A raw `-- <shell>` predicate runs as the bot, on a timer, outside any
    // turn - the same authority a full-access turn has - so that form stays
    // executer and up, checked below. The named waits build their own quoted
    // predicate and a plain timer has none, so those are anyone's.
    minRole: "pal",
    // The confirmation is for the brain, not the thread: it already says what
    // it is waiting for in its own words, and a second notice is just noise.
    quiet: true,
    usage: "pr|checks|reply|url|worker <target> <what to do> | <what to do> -- <shell check> | list | cancel",
    summary: "wait for a PR, CI, a reply, a url or an Orca worker, then carry on in this thread by itself",
    run: async ({ deps, actor, args, rest, prefix, threadTs, channelId }) => {
      if (!deps.watches) return "I have nowhere to keep a watch right now.";
      const sub = (args[0] ?? "").toLowerCase();

      if (sub === "list") {
        // A pal sees their own; the rest name other people's channels and checks.
        const waiting = deps.watches
          .waiting(20)
          .filter((w) => RANK[actor.role] >= RANK.executer || w.slackUserId === actor.slackId);
        if (waiting.length === 0) return "I am not waiting for anything.";
        const now = deps.clock();
        return waiting
          .map(
            (w) =>
              `- #${w.id} <#${w.channelId}> ${w.check ? `\`${w.check.slice(0, 60)}\`` : "timer"} - every ${humanDuration(w.everyMs)}, ${humanDuration(Math.max(0, w.deadlineAt - now))} left, ${w.attempts} checks`,
          )
          .join("\n");
      }

      if (sub === "cancel" || sub === "stop") {
        if (!threadTs) return "Cancel which thread's watch? Run it in the thread.";
        const n = deps.watches.cancelThread(channelId, threadTs, deps.clock());
        return n > 0 ? `stopped ${n} watch${n === 1 ? "" : "es"} here` : "nothing was being watched here.";
      }

      if (!threadTs) {
        return "A watch belongs to a thread - run it in the one that should carry on.";
      }
      const parsed = parseWatchArgs(rest);
      if (!parsed.ok) {
        return `${parsed.error}. \`${prefix} watch pr <url> <what to do>\`, or \`${prefix} watch <what to do> -- <shell check>\``;
      }
      if (parsed.check && RANK[actor.role] < RANK.executer) {
        return `A shell check needs *executer* access. \`${prefix} watch pr|checks|reply|url|worker <target> <what to do>\` is open to you.`;
      }
      const now = deps.clock();
      // A named wait builds its own predicate. The raw `-- <shell>` form still
      // wins if both were given: somebody who wrote a command meant it.
      let check = parsed.check;
      if (!check && parsed.kind) {
        const ref = parsed.kind === "reply" ? parseMessageLink(parsed.target ?? "") : undefined;
        const built = builtinCheck(parsed.kind, parsed.target ?? "", {
          slackWaitScript: deps.slackWaitScript,
          channel: ref?.channel,
          threadTs: ref?.ts,
          // Only what is said from NOW counts; the thread's existing replies
          // are not an answer to a question asked after them.
          afterTs: (now / 1000).toFixed(6),
          from: parsed.from,
          orcaWorkerWait: deps.orcaWorkerWait,
        });
        if ("error" in built) return built.error;
        check = built.check;
      }
      if (!check && !parsed.kind) {
        // A plain timer, which is allowed - but say so, because "watch" with
        // no check reads like it is watching something.
      }
      const w = deps.watches.add(
        {
          channelId,
          threadTs,
          slackUserId: actor.slackId,
          note: parsed.note,
          check,
          everyMs: parsed.everyMs,
          deadlineAt: now + parsed.deadlineMs,
          createdAt: now,
        },
        now,
      );
      const what =
        parsed.kind === "pr"
          ? `${parsed.target} to be merged`
          : parsed.kind === "checks"
            ? `CI on ${parsed.target}`
            : parsed.kind === "reply"
              ? `a reply in that thread${parsed.from ? ` from <@${parsed.from}>` : ""}`
              : parsed.kind === "url"
                ? parsed.target
                : parsed.kind === "worker"
                  ? `Orca worker \`${parsed.target}\` to finish, die or stop for input`
                  : "";
      if (what) {
        return `⏳ waiting for ${what}, checking every ${humanDuration(parsed.everyMs)} and giving up after ${humanDuration(parsed.deadlineMs)}. I will carry on here by myself - you can still talk to me meanwhile. (\`${prefix} watch cancel\`, #${w.id})`;
      }
      return check
        ? `⏳ watching: \`${check.slice(0, 80)}\`\nevery ${humanDuration(parsed.everyMs)}, giving up after ${humanDuration(parsed.deadlineMs)}. I will carry on here by myself when it passes. (\`${prefix} watch cancel\`, #${w.id})`
        : `⏳ I will pick this up again in ${humanDuration(parsed.deadlineMs)}. (\`${prefix} watch cancel\`, #${w.id})`;
    },
  },
  {
    name: "remind",
    aliases: ["reminder", "remindme"],
    // No shell and no turn - a time and a line to post - so anyone may set
    // one. Tagging somebody else is what any Slack user can already do.
    minRole: "pal",
    usage: "[me|<@someone>] (in 2h | at 15:00 [today|tomorrow] | tomorrow 9am | on 2026-12-01) <what> | list | cancel <id>",
    summary: "remind you (or someone) of something here, at a time",
    run: async ({ deps, actor, args, rest, prefix, threadTs, channelId }) => {
      if (!deps.reminders) return "I have nowhere to keep a reminder right now.";
      const now = deps.clock();
      const offset = deps.tzOffsetMinutes?.() ?? -new Date(now).getTimezoneOffset();
      const sub = (args[0] ?? "").toLowerCase();
      const admin = actor.role === "admin" || actor.role === "owner";

      if (sub === "list" && args.length <= 2) {
        const all = admin && (args[1] ?? "").toLowerCase() === "all";
        const rows = all ? deps.reminders.waiting(30) : deps.reminders.waitingFor(actor.slackId, 30);
        if (rows.length === 0) return all ? "No reminders are waiting." : "You have no reminders waiting.";
        return rows
          .map(
            (r) =>
              `- #${r.id} ${formatWhen(r.dueAt, offset)} (${humanLead(r.dueAt - now)}) <#${r.channelId}> ${r.targets.map((t) => `<@${t}>`).join(" ")}: ${r.text.slice(0, 80)}`,
          )
          .join("\n");
      }

      if ((sub === "cancel" || sub === "stop" || sub === "rm") && args.length === 2) {
        const id = Number((args[1] ?? "").replace(/^#/, ""));
        const r = Number.isInteger(id) ? deps.reminders.get(id) : undefined;
        if (!r || r.state !== "waiting") return `There is no waiting reminder #${args[1]}.`;
        // Whoever set it, whoever it is for, or an admin. Anyone else would be
        // quietly deleting somebody's promise to themselves.
        if (r.createdBy !== actor.slackId && !r.targets.includes(actor.slackId) && !admin) {
          return `#${r.id} is not yours to cancel - ask <@${r.createdBy}>.`;
        }
        deps.reminders.settle(r.id, "cancelled", now);
        return `cancelled reminder #${r.id}`;
      }

      const parsed = parseRemindArgs(rest, actor.slackId, now, offset);
      if (!parsed.ok) {
        return `${parsed.error}. \`${prefix} remind me in 2h check the deploy\`, or \`${prefix} remind <@someone> tomorrow 9am standup notes\``;
      }
      const r = deps.reminders.add(
        { channelId, threadTs: threadTs ?? "", createdBy: actor.slackId, targets: parsed.targets, text: parsed.text, dueAt: parsed.dueAt },
        now,
      );
      const who = parsed.targets.length === 1 && parsed.targets[0] === actor.slackId
        ? "you"
        : parsed.targets.map((t) => `<@${t}>`).join(" ");
      return `⏰ I will remind ${who} ${formatWhen(parsed.dueAt, offset)} (${humanLead(parsed.dueAt - now)}) ${threadTs ? "in this thread" : "here"}. (\`${prefix} remind cancel ${r.id}\`)`;
    },
  },
  {
    name: "mindful",
    aliases: ["mind", "whatsup"],
    // It names people, quotes what they asked, and spans every conversation
    // the bot can see - DMs and private channels the reader may not be in.
    minRole: "admin",
    usage: "[hours] | continue <thread link> | reply <thread link> [what to say]",
    summary: "everything I am doing: what is stuck, what is running, what it cost",
    run: async (ctx) => {
      const { deps, actor, args, prefix, channelId } = ctx;
      const sub = (args[0] ?? "").toLowerCase();
      const team = deps.slackTeam?.();

      if (sub === "continue" || sub === "retry" || sub === "reply") {
        if (!deps.runTurn) return "I cannot start a turn from here right now.";
        const ref = parseMessageLink((args[1] ?? "").replace(/^<|>$/g, ""));
        if (!ref) return `Which thread? \`${prefix} mindful ${sub} <thread link>\``;
        const said = args.slice(2).join(" ").trim();

        if (sub === "reply") {
          // Nudging a thread it has gone quiet in. With nothing said, it is
          // told to catch up and answer only if it has something - the same
          // judgement it uses when following its own threads.
          const text =
            said ||
            "Read this thread from the start, then reply only if you have something it needs. If you do not, say nothing.";
          await deps.runTurn({ channelId: ref.channel, threadTs: ref.ts, slackUserId: actor.slackId, text });
          return `nudged that thread${said ? "" : " - it will answer only if it has something"} 🫧`;
        }

        // Continue: run the dead turn again, as the person who asked for it
        // the first time. Their request is in the turn log precisely so this
        // does not depend on a `messages` table a `forget` can empty.
        const last = deps.turns?.latestInThread(ref.channel, ref.ts);
        if (!last) return "I have no record of a turn in that thread.";
        if (last.outcome === "ok" && !said) {
          return `The last turn there finished fine. \`${prefix} mindful reply <link> <what to ask>\` if you want something new.`;
        }
        const text = said || last.request;
        if (!text.trim()) return "That turn left nothing to run again.";
        await deps.runTurn({
          channelId: ref.channel,
          threadTs: ref.ts,
          slackUserId: last.slackUserId || actor.slackId,
          text,
        });
        return `running that one again for <@${last.slackUserId || actor.slackId}> 🔁`;
      }

      const windowMs = parseWindow(args[0]) ?? 4 * 60 * 60_000;
      const since = deps.clock() - windowMs;

      const live: LiveRun[] = (deps.runs?.all() ?? []).map((r) => ({
        id: r.id,
        channelId: r.channelId,
        threadTs: r.threadTs,
        actor: r.actor,
        what: r.what,
        startedAt: r.startedAt,
        state: r.state,
      }));

      const recent = deps.turns?.since(since, 500) ?? [];
      const done = {
        ok: recent.filter((t) => t.outcome === "ok").length,
        failed: recent.filter((t) => t.outcome === "failed").length,
        stopped: recent.filter((t) => t.outcome === "stopped").length,
      };

      const view: MindfulView = {
        now: deps.clock(),
        live,
        stuck: (deps.turns?.stuckThreads(since, 12) ?? []).map((t) => ({
          channelId: t.channelId,
          threadTs: t.threadTs,
          slackUserId: t.slackUserId,
          request: t.request,
          error: t.error,
          outcome: t.outcome,
          endedAt: t.endedAt,
        })),
        watching: (deps.watches?.waiting(15) ?? []).map((w) => ({
          id: w.id,
          channelId: w.channelId,
          threadTs: w.threadTs,
          check: w.check,
          note: w.note,
          deadlineAt: w.deadlineAt,
          attempts: w.attempts,
        })),
        workflows: (deps.workflows?.listActive() ?? []).map((w) => ({
          channelId: w.channelId,
          threadTs: w.threadTs,
          task: w.task,
          lastTurnAt: w.updatedAt,
        })),
        done,
        spend: deps.usage?.totals(since) ?? {
          runs: 0,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
          durationMs: 0,
        },
        windowMs,
      };

      // One permalink resolves the workspace domain; every other link is then
      // built from ids rather than costing an API call of its own.
      const anchor = view.stuck[0] ?? view.workflows[0];
      const resolved =
        team ??
        (anchor && deps.slack?.permalink
          ? teamFromPermalink(await deps.slack.permalink(anchor.channelId, anchor.threadTs))
          : undefined);
      const report = mindfulReport(view, resolved);
      const hint = view.stuck.length > 0 ? `\n\n_\`${prefix} mindful continue <thread link>\` runs a stuck one again_` : "";
      void channelId;
      return `${report}${hint}`;
    },
  },
];
