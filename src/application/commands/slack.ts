/** Acting in Slack and on threads: bomb, limit, workflow, rm-msg, tell, reply. */

import { BOMB_SIZE, DEFAULT_CATEGORY, parseCategories, pickBomb, renderCategories } from "../../domain/emoji.ts";
import { parseMessageLink } from "../../domain/slackLinks.ts";
import { runWorkflowTurn, WORKFLOW_MIN_ROLE, type WorkflowDeps } from "../workflow.ts";
import { afterWorkflowTurn, steerWorker } from "../workflowContinue.ts";
import { allowanceFor, limitFor, PAL_WINDOW_MS, setLimit, type CommandLimitDeps } from "../commandLimits.ts";
import { forHowLong } from "../../domain/runControl.ts";
import { tellPrompt } from "../../domain/tellPrompt.ts";
import { frontKeyOf } from "../../domain/workflowFront.ts";
import { workerStateOf } from "../workflowFront.ts";
import type { UserRole } from "../../domain/types.ts";
import { type CommandDef, RANK, slackIdOf } from "./shared.ts";
import { logAndIgnore } from "../ignoredError.ts";

/** Roles an allowance applies to; mirrors LIMITED_ROLES without the import cycle. */
const LIMITED: readonly UserRole[] = ["pal"];

export const SLACK_COMMANDS: readonly CommandDef[] = [
  {
    name: "bomb",
    aliases: ["br"],
    minRole: "admin",
    usage: "[categories] [count] <message-link> | help",
    summary: `reaction-bomb a message (combine categories with commas; \`bomb help\` lists them)`,
    run: async ({ deps, args, prefix }) => {
      const usage = `\`${prefix} bomb [categories] [count] <message-link>\`
Combine with commas and set a count, e.g. \`${prefix} bomb money,face,negative 9 <link>\`
Up to ${BOMB_SIZE} reactions; no category means *${DEFAULT_CATEGORY}*.`;
      if (args.length === 1 && /^(help|\?|list|categories)$/i.test(args[0] ?? "")) {
        return `${usage}\n\n${renderCategories()}`;
      }
      if (!deps.slack) return "Slack tools are not available.";

      // Last arg is the link; the tokens before it are the category list and an
      // optional count, in either order - a bare number can only be the count.
      const link = args[args.length - 1] ?? "";
      const ref = parseMessageLink(link.replace(/^<|>$/g, ""));
      if (!ref) return `Paste a Slack message link:\n${usage}`;

      let count = BOMB_SIZE;
      let categories = [DEFAULT_CATEGORY];
      for (const token of args.slice(0, -1)) {
        if (/^\d+$/.test(token)) count = Math.min(Math.max(Number(token), 1), BOMB_SIZE);
        else categories = parseCategories(token);
      }

      const { emojis, used, unknown } = pickBomb(categories, count);
      if (emojis.length === 0) {
        return `No emoji for ${unknown.map((u) => `*${u}*`).join(", ") || "that"}.\n\n${renderCategories()}`;
      }
      const landed = await deps.slack.addReactions(ref.channel, ref.ts, emojis);
      if (landed === 0) return "Could not add any reactions (already bombed, or I am not in that channel).";
      const skipped = unknown.length > 0 ? ` (no such category: ${unknown.join(", ")})` : "";
      const short = landed < count ? `, ${count - landed} did not stick` : "";
      return `💥 dropped ${landed} *${used.join(", ")}* reactions${short}${skipped}`;
    },
  },
  {
    name: "limit",
    aliases: ["quota"],
    minRole: "pal",
    usage: "[@user] [n|default]",
    summary: "show command allowance; admins can set someone's",
    run: (ctx) => {
      const { deps, actor, args, prefix, trivialCommands } = ctx;
      const window = Math.round(PAL_WINDOW_MS / 3_600_000);
      const report = (id: string): string => {
        const target = deps.users.get(id);
        if (!target) return "I do not know that user.";
        const allowance = allowanceFor(deps as CommandLimitDeps, target, trivialCommands);
        if (!LIMITED.includes(target.role)) return `<@${id}> is *${target.role}* - no allowance applies.`;
        return `<@${id}>: ${allowance.used}/${allowance.limit} commands used in the last ${window}h.`;
      };

      const slackId = slackIdOf(args[0]);
      // No target: your own standing.
      if (!slackId) return report(actor.slackId);
      if (args.length === 1) {
        if (RANK[actor.role] < RANK.admin && slackId !== actor.slackId) {
          return "Only admins can look up someone else's allowance.";
        }
        return report(slackId);
      }

      if (RANK[actor.role] < RANK.admin) return "Only admins can change an allowance.";
      const raw = (args[1] ?? "").toLowerCase();
      if (raw === "default" || raw === "reset") {
        setLimit(deps as CommandLimitDeps, slackId, undefined);
        return `<@${slackId}> is back on the default allowance (${limitFor(deps as CommandLimitDeps, slackId)} per ${window}h).`;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) return `How many? \`${prefix} limit @user <number|default>\``;
      setLimit(deps as CommandLimitDeps, slackId, n);
      return n === 0
        ? `<@${slackId}> now needs approval for every command.`
        : `<@${slackId}> can now run *${n}* commands per ${window}h.`;
    },
  },
  {
    name: "workflow",
    aliases: ["wf"],
    minRole: WORKFLOW_MIN_ROLE,
    usage: "<task> | stop [<thread-link>] | status",
    summary: "start a long task in this thread and keep talking to it",
    // Stopping another thread's workflow is housekeeping: the result goes back
    // to whoever asked, and nothing is posted in either thread.
    quiet: (args) => /^stop$/i.test(args[0] ?? "") && args.length > 1,
    run: async (ctx) => {
      const { deps, actor, channelId, threadTs, rest, prefix, reply } = ctx;
      if (!deps.workflows) return "Workflows are not available.";
      const remote = rest.trim().match(/^stop\s+(\S+)$/i)?.[1];
      if (remote) {
        // Sending `workflow stop` there with `tell` left an echo and a reply in
        // every thread it cleaned up, so this stops it in place without a word.
        const link = remote.replace(/^<|>$/g, "").replace(/&amp;/g, "&");
        const ref = parseMessageLink(link);
        if (!ref) return `Paste a Slack thread link: \`${prefix} workflow stop <thread-link>\``;
        const root = link.match(/[?&]thread_ts=(\d+\.\d+)/)?.[1] ?? ref.ts;
        const there = deps.workflows.activeFor(ref.channel, root);
        if (!there) return "No workflow running in that thread.";
        deps.workflows.stop(there.id, deps.clock());
        const key = `${ref.channel}:${root}`;
        deps.runs?.stopThread(key, actor.slackId);
        deps.runs?.stopThread(frontKeyOf(key), actor.slackId);
        return `🛑 stopped the workflow in that thread after ${there.turns} turn${there.turns === 1 ? "" : "s"}, nothing posted there.`;
      }
      if (!threadTs) {
        return `Workflows live in a thread - use \`${prefix} workflow <task>\` in a channel or DM rather than the slash command.`;
      }
      const live = deps.workflows.activeFor(channelId, threadTs);
      const sub = rest.trim();

      const workerKey = `${channelId}:${threadTs}`;
      if (/^stop$/i.test(sub)) {
        if (!live) return "No workflow running in this thread.";
        deps.workflows.stop(live.id, deps.clock());
        // Both halves: the worker's step in flight and the front's answer.
        // Queued worker steps find the workflow stopped and stand down.
        deps.runs?.stopThread(workerKey, actor.slackId);
        deps.runs?.stopThread(frontKeyOf(workerKey), actor.slackId);
        return `🛑 workflow stopped after ${live.turns} turn${live.turns === 1 ? "" : "s"}. The thread goes back to normal chat.`;
      }
      if (/^status$/i.test(sub)) {
        if (!live) return "No workflow running in this thread.";
        const alone = live.autoTurns > 0 ? `, ${live.autoTurns} on its own since it was last steered` : "";
        const state = workerStateOf(deps, live, workerKey);
        const now =
          state.state === "running"
            ? ` A step is running (${forHowLong(deps.clock() - state.since)} so far).`
            : state.state === "queued"
              ? " Next step is queued."
              : " Idle - waiting on someone.";
        const steers = live.steers.length > 0 ? ` ${live.steers.length} instruction(s) waiting for the next step.` : "";
        return `⚙️ workflow running - started by <@${live.startedBy}>, ${live.turns} turn${live.turns === 1 ? "" : "s"} so far${alone}.${now}${steers}\n> ${live.task}`;
      }
      if (live) {
        return `A workflow is already running in this thread (${live.turns} turns). Just talk to it, or \`${prefix} workflow stop\` to end it.`;
      }
      if (!sub) return `What should I work on? \`${prefix} workflow <task>\``;
      if (!deps.llm) return "My brain is not wired up right now.";

      const workflow = deps.workflows.start(
        {
          channelId,
          threadTs,
          sessionId: (deps.newSessionId ?? (() => crypto.randomUUID()))(),
          task: sub,
          startedBy: actor.slackId,
        },
        deps.clock(),
      );

      // The first step is the worker's like every later one: on the thread's
      // queue, so a steer cannot start a second step beside it, and tracked,
      // so it can be stopped.
      const tracked = deps.runs?.track({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        key: workerKey,
        channelId,
        threadTs,
        actor: actor.slackId,
        what: "workflow start",
        startedAt: deps.clock(),
      });
      const firstStep = async () => {
        tracked?.running();
        try {
          return await runWorkflowTurn(deps as WorkflowDeps, workflow, actor, sub, true, undefined, tracked?.signal);
        } finally {
          tracked?.done();
        }
      };
      const runFirst = async () => {
        try {
          return await (deps.threadQueue ? deps.threadQueue.run(workerKey, firstStep) : firstStep());
        } catch (err) {
          if (tracked?.signal.aborted) return undefined;
          throw err;
        }
      };

      // No live destination (tests / slack off): run the turn and return it.
      if (!reply) {
        const turn = await runFirst();
        if (!turn) return "";
        await afterWorkflowTurn(deps, workflow, actor.slackId, turn.wantsContinue, prefix);
        return turn.text;
      }

      await reply(
        `⚙️ workflow started - I will keep working on it step by step in the background until it is done or I need you. Talk to me here any time - I answer while the work runs, and pass on anything meant for it; \`${prefix} workflow stop\` ends it.`,
      );
      const turn = await runFirst();
      if (!turn) return "";
      if (turn.text.trim()) await reply(turn.text);
      // The next step goes through the ordinary turn path, behind anything a
      // human said meanwhile.
      await afterWorkflowTurn(deps, workflow, actor.slackId, turn.wantsContinue, prefix);
      return ""; // already delivered to the thread
    },
  },
  {
    name: "rm-msg",
    aliases: ["rmmsg", "unsend"],
    minRole: "admin",
    usage: "<message-link>",
    summary: "delete a message I posted",
    // The brain tidying up must not leave a "deleted" note behind for every message.
    quiet: true,
    run: async ({ deps, args, prefix }) => {
      if (!deps.slack) return "Slack tools are not available.";
      const ref = parseMessageLink((args[0] ?? "").replace(/^<|>$/g, ""));
      if (!ref) return `Paste a Slack message link: \`${prefix} rm-msg <message-link>\``;
      try {
        await deps.slack.remove(ref.channel, ref.ts);
        return "🗑️ deleted that one";
      } catch (e) {
        // A bot token may only delete what the bot itself posted, so the usual
        // failure is someone else's message rather than anything being wrong.
        const err = e instanceof Error ? e.message : String(e);
        if (/cant_delete_message|message_not_found/.test(err)) {
          return "I can only delete messages I posted myself - that one is not mine (or is already gone).";
        }
        return `Could not delete it: ${err}`;
      }
    },
  },
  {
    name: "tell",
    aliases: ["relay"],
    // It steers a session in a room the sender may not be watching.
    minRole: "admin",
    // The confirmation goes back to the caller: a batch of tells left one
    // "sent" line per thread in the thread that sent them.
    quiet: true,
    usage: "<thread-link> <message>",
    summary: "steer another thread's session with a message; posts nothing in Slack, there or here",
    run: async ({ deps, actor, args, prefix, channelId, threadTs }) => {
      // A session in one thread could not steer the session in another, so the
      // owner copied instructions between threads by hand. This delivers the
      // message to that thread's own session (its workflow if it has one) and
      // posts nothing in Slack: no echo of the message, and the turn is told
      // not to acknowledge it.
      if (!deps.runTurn) return "I cannot start a turn from here right now.";
      const link = (args[0] ?? "").replace(/^<|>$/g, "").replace(/&amp;/g, "&");
      const ref = parseMessageLink(link);
      if (!ref) return `Paste a Slack thread link: \`${prefix} tell <thread-link> <message>\``;
      const root = link.match(/[?&]thread_ts=(\d+\.\d+)/)?.[1] ?? ref.ts;
      const message = args.slice(1).join(" ").trim();
      if (!message) return `And what to tell it? \`${prefix} tell <thread-link> <message>\``;
      if (ref.channel === channelId && root === threadTs) return "That is this thread - just say it here.";
      // A workflow thread takes it straight into the worker's queue: no echo,
      // no front turn. Going through the front posted the message twice in a
      // thread already full of its own progress (the echo, then the front's
      // "passing it on"), for an instruction meant only for the work.
      const workflow = deps.workflows?.activeFor(ref.channel, root);
      if (workflow) {
        const outcome = steerWorker(deps, workflow, actor.slackId, [message], `${ref.channel}:${root}`);
        if (outcome === "kicked") return "sent straight to that workflow's worker - it was idle, so it starts now 📨";
        if (outcome === "queued") return "sent straight to that workflow's worker - it gets it at its next step 📨";
      }
      // Nothing is posted in the target thread: the message goes to its session
      // as an internal steer, and that turn is told to stay silent unless its
      // work produces something for the people there. `unprompted` marks it
      // as a turn nobody typed.
      void deps
        .runTurn({
          channelId: ref.channel,
          threadTs: root,
          slackUserId: actor.slackId,
          text: tellPrompt(actor.slackId, message),
          keepSession: true,
          unprompted: true,
        })
        .catch(logAndIgnore("slack command run turn"));
      return "sent - that thread is on it, nothing posted there 📨";
    },
  },
  {
    name: "reply",
    aliases: ["jrp"],
    minRole: "admin",
    usage: "<message-link> [what to tell them]",
    summary: "answer a message properly, in its own thread",
    run: async ({ deps, actor, args, prefix }) => {
      // A real turn in that thread, not a one-shot draft. The draft saw names
      // instead of ids, so it broke tags, and it never opened a screenshot or
      // looked anything up - it answered the words and missed the problem.
      if (!deps.runTurn) return "I cannot start a turn from here right now.";
      const link = (args[0] ?? "").replace(/^<|>$/g, "").replace(/&amp;/g, "&");
      const ref = parseMessageLink(link);
      if (!ref) return `Paste a Slack message link: \`${prefix} reply <message-link>\``;
      const root = link.match(/[?&]thread_ts=(\d+\.\d+)/)?.[1] ?? ref.ts;
      const said = args.slice(1).join(" ").trim();
      const text = [
        `<@${actor.slackId}> wants you to answer the message at ts ${ref.ts} in this thread, posted by someone else.`,
        "Read the whole thread first, open every link and attachment on that message, and investigate whatever it needs before you answer.",
        "Address its author by their Slack tag, not the person who asked you, and do not ask them for anything the thread already shows.",
        said ? `What to tell them: ${said}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      // Not awaited: a real answer can take minutes, and the person who asked
      // should not hold a command open for it. The turn posts its own reply.
      void deps.runTurn({ channelId: ref.channel, threadTs: root, slackUserId: actor.slackId, text }).catch(logAndIgnore("slack command run turn"));
      return "on it, answering in that thread 🙈";
    },
  },
];
