/** Runs, sessions and credentials: stop, session, token, 2fa, review-agents. */

import { asAgentCap, DEFAULT_REVIEW_AGENTS, REVIEW_AGENT_CEILING } from "../../domain/reviewPrompt.ts";
import { tokenHint } from "../../domain/claudeToken.ts";
import { encodeTotpRequest, TOTP_ACTION } from "../totp.ts";
import { normaliseLabel, secondsLeft, totpCode } from "../../domain/totp.ts";
import { tierOf } from "../../domain/threadSession.ts";
import { forHowLong, stillStoppingNotice, stoppedNotice } from "../../domain/runControl.ts";
import { NOTHING_IN_BACKGROUND, stopReply } from "../../domain/threadBackground.ts";
import { SETTING_KEYS } from "../../infrastructure/db/settingsRepo.ts";
import { type Context, type CommandDef, RANK, askForToken, since, reviewAgentsOf } from "./shared.ts";

/**
 * A code with only a moment left is a code that fails while it is being typed,
 * so under this many seconds the next one is handed over instead.
 */
const MIN_CODE_SECONDS = 5;

/**
 * Ask for a 2FA setup key, with the button that opens the modal. Same shape as
 * the token ask and for the same reason: the key itself is never typed into a
 * channel, and the button carries only the label it will be filed under.
 *
 * Returns "" when the button was posted (the thread has it), or the text to show
 * when there is nowhere to put one - a slash invocation, or no Slack wired up.
 */
const askForSecret = async (ctx: Context, label: string): Promise<string> => {
  const { deps, channelId, threadTs, slash } = ctx;
  const ask = `🔐 paste the setup key for \`${label}\` - the \`otpauth://\` link the QR code encodes, or the base32 key printed beside it`;
  if (ctx.reply && deps.slack?.postInteractive) {
    const posted = await deps.slack
      .postInteractive(
        channelId,
        ask,
        [
          {
            actionId: TOTP_ACTION,
            label: "Paste the setup key",
            value: encodeTotpRequest({ channelId, threadTs, label }),
            style: "primary",
          },
        ],
        threadTs,
      )
      .catch(() => undefined);
    if (posted) return "";
  }
  return `${ask}\n\nrun \`${slash} 2fa add ${label}\` in a channel I am in and a box will open for it`;
};

export const RUNTIME_COMMANDS: readonly CommandDef[] = [
  {
    name: "stop",
    aliases: ["cancel", "abort"],
    minRole: "pal",
    usage: "",
    summary: "stop the turn running in this thread, and the background agents its turns started",
    run: async ({ deps, actor, channelId, threadTs }) => {
      if (!deps.runs) return "I cannot stop anything right now.";
      if (!threadTs) return "That only means something inside a thread.";
      const key = `${channelId}:${threadTs}`;
      const running = deps.runs.current(key);
      const isAdmin = RANK[actor.role] >= RANK.admin;
      // Your own turn is yours to stop; someone else's takes an admin, since a
      // turn is their work and often their money. Refused, nothing is touched -
      // the background agents included.
      if (running && running.actor !== actor.slackId && !isAdmin) {
        return `That one is <@${running.actor}>'s, and it has been going ${forHowLong(deps.clock() - running.startedAt)}. Only they or an admin can stop it.`;
      }
      // A stop is a REQUEST. Asking twice must not read as two successful
      // stops - that is the lie the `stopping` state exists to prevent, and
      // this path had it too: the result of `stop` was thrown away and the
      // notice written regardless.
      let turnLine: string | undefined;
      if (running?.state === "stopping") turnLine = stillStoppingNotice(running, deps.clock());
      else if (running) {
        const stopped = deps.runs.stop(running.id, actor.slackId);
        turnLine = stopped ? stoppedNotice(stopped, actor.slackId, deps.clock()) : "that one finished on its own just now.";
      }
      // Killing the turn ends what runs inside its process (the Agent tool's
      // background agents, its shells). A `claude --bg` session or an Orca
      // worker it started lives outside that tree and kept working after a
      // stop, so those are looked up from the thread's trace and stopped too -
      // this turn's and every earlier turn's.
      const background = deps.backgroundAgents
        ? await deps.backgroundAgents
            .stopForThread({ channelId, threadTs, actor: actor.slackId, mayStopOthers: isAdmin })
            .catch(() => NOTHING_IN_BACKGROUND)
        : NOTHING_IN_BACKGROUND;
      const reply = stopReply(turnLine, background);
      if (reply) return reply;
      // Said plainly: "nothing is running" and "I could not stop it" are very
      // different things to read when you are watching something misbehave.
      const waiting = deps.runs.inThread(key).length;
      return waiting > 0
        ? `Nothing is running yet - ${waiting} ${waiting === 1 ? "turn is" : "turns are"} waiting behind it.`
        : "Nothing is running in this thread.";
    },
  },
  {
    name: "session",
    aliases: ["sess"],
    minRole: "pal",
    usage: "[reset|on|off]",
    summary: "the CLI session this thread is talking to",
    run: ({ deps, actor, channelId, threadTs, args, prefix }) => {
      const on = deps.threadSessionsOn?.() !== false;
      const want = (args[0] ?? "").toLowerCase();

      if (want === "on" || want === "off") {
        if (RANK[actor.role] < RANK.admin) return "Only admins can switch thread sessions.";
        deps.settings?.set(SETTING_KEYS.threadSessions, want === "off" ? "off" : "");
        return want === "off"
          ? "Thread sessions *off* - every turn is a cold call again, with the thread replayed into it."
          : "Thread sessions *on* - each thread keeps one session between turns.";
      }
      if (args.length > 0 && want !== "reset" && want !== "new") {
        return `\`${prefix} session [reset|on|off]\``;
      }
      if (!deps.threadSessions) return "Thread sessions are not wired up here.";
      if (!on) return "Thread sessions are *off* right now, so every turn starts cold.";
      if (!threadTs) return "That only means something inside a thread.";

      // Your own tier: what you would resume, not what someone else would.
      const tier = tierOf(deps.toolPolicy?.(actor.role, channelId));
      const bound = deps.threadSessions.find(channelId, threadTs, tier);
      if (want === "reset" || want === "new") {
        deps.threadSessions.drop(channelId, threadTs);
        return bound
          ? "Dropped it - the next message in this thread starts a fresh session with the thread read back in."
          : "Nothing bound here anyway, so the next message starts fresh.";
      }
      return bound
        ? `This thread is on one session, ${bound.turns} ${bound.turns === 1 ? "turn" : "turns"} in. \`${prefix} session reset\` starts it over.`
        : "No session bound yet - the next message in this thread opens one.";
    },
  },
  {
    name: "token",
    aliases: ["claude-token"],
    minRole: "pal",
    usage: "[remove|who]",
    summary: "your own Claude Code token, which your reviews run on",
    run: async (ctx) => {
      const { deps, actor, args, slash } = ctx;
      if (!deps.claudeTokens) return "Token storage is not wired up here.";
      const want = (args[0] ?? "").toLowerCase();

      if (want === "remove" || want === "forget" || want === "delete") {
        const had = deps.claudeTokens.get(actor.slackId);
        deps.claudeTokens.remove(actor.slackId);
        return had
          ? `Forgotten your token (${tokenHint(had)}). Your reviews will ask for a new one.`
          : "I did not have a token for you anyway.";
      }
      // Before the catch-all below, or it is never reached - which is exactly
      // what happened: `token who` answered with the usage line instead.
      if (want === "who" || want === "count" || want === "list" || want === "users") {
        if (RANK[actor.role] < RANK.admin) return "Only admins can see that.";
        const held = deps.claudeTokens.list();
        if (held.length === 0) {
          return `Nobody has given me a token yet, so nobody can run a review. \`${slash} token\` opens the box.`;
        }
        const lines = held.map((h) => {
          const name = deps.users.get(h.slackId)?.displayName;
          return `- <@${h.slackId}>${name ? ` (${name})` : ""}, added ${since(deps.clock() - h.updatedAt)}`;
        });
        return `${held.length} ${held.length === 1 ? "person has" : "people have"} given me a token. I never show one, not even to you.\n${lines.join("\n")}`;
      }
      if (args.length > 0 && want !== "add" && want !== "set") {
        return `\`${slash} token\` to add or replace one, \`${slash} token remove\` to forget it.`;
      }

      const mine = deps.claudeTokens.get(actor.slackId);
      // Never accept a token as command text: a message is readable by everyone
      // in the channel, lands in the bot's memory, and outlives the turn. The
      // box the button opens is not a message.
      const box = await askForToken(ctx, "", true);
      if (!mine) return box || "";
      return box
        ? `You already have a token on file (${tokenHint(mine)}).\n\n${box}`
        : `You already have a token on file (${tokenHint(mine)}) - the box above replaces it.`;
    },
  },
  {
    name: "2fa",
    aliases: ["totp", "otp"],
    minRole: "executer",
    usage: "<label> | list | add <label> | remove <label>",
    summary: "a 2FA code for a shared login I hold the setup key for",
    run: async (ctx) => {
      const { deps, actor, args, slash } = ctx;
      if (!deps.totp) return "2FA storage is not wired up here.";
      const sub = (args[0] ?? "").toLowerCase();

      if (args.length === 0 || sub === "list" || sub === "ls") {
        const held = deps.totp.list();
        if (held.length === 0) {
          return `I hold no setup keys yet. An admin adds one with \`${slash} 2fa add <name>\`.`;
        }
        const lines = held.map(
          (h) => `- \`${h.label}\`${h.account ? ` - ${h.account}` : ""}, added by <@${h.addedBy}> ${since(deps.clock() - h.updatedAt)}`,
        );
        return `${held.length} shared ${held.length === 1 ? "login" : "logins"}. \`${slash} 2fa <name>\` for a code.\n${lines.join("\n")}`;
      }

      if (sub === "add" || sub === "set") {
        if (RANK[actor.role] < RANK.admin) return "Only admins can add a setup key.";
        const label = normaliseLabel(args.slice(1).join(" "));
        if (!label) return `Name it: \`${slash} 2fa add <name>\` - that name is how you ask for a code later.`;
        // Never accept a setup key as command text: a message is readable by
        // everyone in the channel, lands in my memory, and outlives the turn.
        // The box the button opens is not a message.
        const box = await askForSecret(ctx, label);
        const replacing = deps.totp.has(label) ? `\`${label}\` already has a key - this replaces it.\n\n` : "";
        return box ? `${replacing}${box}` : "";
      }

      if (sub === "remove" || sub === "forget" || sub === "delete") {
        if (RANK[actor.role] < RANK.admin) return "Only admins can remove a setup key.";
        const label = normaliseLabel(args.slice(1).join(" "));
        if (!label) return `Which one? \`${slash} 2fa remove <name>\`.`;
        return deps.totp.remove(label)
          ? `Forgotten the setup key for \`${label}\`. Nobody gets a code for it from me now.`
          : `I had no setup key for \`${label}\` anyway.`;
      }

      const label = normaliseLabel(args.join(" "));
      const cfg = deps.totp.get(label);
      if (!cfg) {
        const known = deps.totp.list().map((h) => `\`${h.label}\``);
        return known.length
          ? `No setup key for \`${label}\`. I have ${known.join(", ")}.`
          : `No setup key for \`${label}\`, and I hold none at all yet.`;
      }
      const now = deps.clock();
      const left = secondsLeft(cfg, now);
      // A code with a couple of seconds on it is a code that fails while you are
      // still typing it, so hand over the next one rather than that.
      if (left <= MIN_CODE_SECONDS) {
        const next = totpCode(cfg, now + left * 1000);
        return `\`${next}\` for \`${label}\` - the one on screen right now expires in ${left}s, so this is the next one. Give it ${left}s.`;
      }
      return `\`${totpCode(cfg, now)}\` for \`${label}\`${cfg.account ? ` (${cfg.account})` : ""} - ${left}s left.`;
    },
  },
  {
    name: "review-agents",
    aliases: ["rvagents"],
    minRole: "pal",
    usage: "[n|default]",
    summary: "how many child agents one review may fan out to",
    run: (ctx) => {
      const { deps, actor, args, prefix } = ctx;
      const current = reviewAgentsOf(deps);
      const describe = (n: number) => `at most *${n}* child ${n === 1 ? "agent" : "agents"} per review`;
      if (args.length === 0) {
        const own = asAgentCap(deps.settings?.get(SETTING_KEYS.reviewAgents));
        return own
          ? `${describe(own)} (the default is ${DEFAULT_REVIEW_AGENTS}).`
          : `${describe(current)} - the default.`;
      }
      if (RANK[actor.role] < RANK.admin) return "Only admins can change the review agent cap.";
      const want = (args[0] ?? "").toLowerCase();
      if (args.length > 1) return `How many? \`${prefix} review-agents <n|default>\``;
      if (want === "default" || want === "reset") {
        deps.settings?.remove(SETTING_KEYS.reviewAgents);
        return `Back on the default, ${describe(DEFAULT_REVIEW_AGENTS)}.`;
      }
      const n = asAgentCap(want);
      if (!n) return `A number from 1 to ${REVIEW_AGENT_CEILING}, or \`default\`.`;
      deps.settings?.set(SETTING_KEYS.reviewAgents, String(n));
      return `Reviews now spawn ${describe(n)}.`;
    },
  },
];
