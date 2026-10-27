/**
 * One-turn tickets for running a command on someone's behalf.
 *
 * The brain can ask the bot to run a real command, but it must not be the one
 * to say *whose* command it is: a sandboxed session that could name its own
 * actor could name the owner instead, and a `pal` would have a way to run
 * anything. So the bot mints a ticket bound to the person it is actually
 * talking to, hands that to the brain, and resolves the actor from the ticket
 * when it comes back. The brain never names anyone.
 *
 * Tickets live in memory: they are worth nothing after the conversation has
 * moved on, and losing them on restart is the correct behaviour.
 *
 * The use budget is a RUNAWAY GUARD, not a rate limit. It was five, which is
 * neither: asked to delete 26 messages the bot got through five, was told its
 * ticket was "not valid any more", guessed twice at why, and ended up offering
 * to bypass the audited command path with a raw API call - which is the exact
 * escalation this whole mechanism exists to prevent. A guard that stops
 * ordinary work turns into pressure to work around it. The number is now big
 * enough that only a loop hits it, and a spent ticket says so in those words
 * rather than looking like an expired one.
 */
import type { Clock } from "./ports.ts";

/** How long a ticket stays good - a long review turn, not a session. */
export const TICKET_TTL_MS = 20 * 60_000;
/**
 * Commands one turn may trigger. High enough that real bulk work finishes and
 * only an unbounded loop reaches it; the TTL bounds it in time as well.
 */
export const TICKET_USES = 50;

export type TicketContext = {
  /** Slack id the command runs as. */
  actor: string;
  channel: string;
  threadTs?: string;
};

/**
 * Why a ticket did not resolve. The distinction matters: "spent" is a budget
 * the turn can report honestly, "expired" and "unknown" mean the ticket is
 * simply gone and retrying is pointless.
 */
export type TicketRefusal = "unknown" | "expired" | "spent";

export type TicketResult =
  | { readonly ok: true; readonly ctx: TicketContext; readonly left: number }
  | { readonly ok: false; readonly reason: TicketRefusal; readonly limit: number };

export type CommandTickets = {
  issue: (ctx: TicketContext) => string;
  /** Resolve and spend a use. */
  redeem: (token: string) => TicketResult;
};

type Entry = TicketContext & { expiresAt: number; used: number };

export const createCommandTickets = (
  clock: Clock,
  newToken: () => string = () => crypto.randomUUID().replaceAll("-", ""),
  uses: number = TICKET_USES,
): CommandTickets => {
  const live = new Map<string, Entry>();

  const sweep = (now: number): void => {
    for (const [token, e] of live) if (e.expiresAt <= now) live.delete(token);
  };

  return {
    issue: (ctx) => {
      const now = clock();
      sweep(now);
      const token = newToken();
      live.set(token, { ...ctx, expiresAt: now + TICKET_TTL_MS, used: 0 });
      return token;
    },
    redeem: (token) => {
      const entry = live.get(token);
      if (!entry) return { ok: false, reason: "unknown", limit: uses };
      const now = clock();
      if (entry.expiresAt <= now) {
        live.delete(token);
        return { ok: false, reason: "expired", limit: uses };
      }
      // Kept until it expires rather than deleted on the last use, so the next
      // attempt can say "you have spent this turn's budget" instead of the
      // indistinguishable "I have never heard of that ticket".
      if (entry.used >= uses) return { ok: false, reason: "spent", limit: uses };
      entry.used += 1;
      return {
        ok: true,
        ctx: { actor: entry.actor, channel: entry.channel, threadTs: entry.threadTs },
        left: uses - entry.used,
      };
    },
  };
};

/** What the brain is told when a ticket will not resolve. */
export const refusalMessage = (reason: TicketRefusal, limit: number): string =>
  reason === "spent"
    ? `this turn has already run its ${limit} commands, which is the runaway guard. Do NOT work around it with raw API calls - finish up, say plainly what you did and what is left, and let them ask again.`
    : "that ticket is not valid any more";
