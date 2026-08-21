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
 */
import type { Clock } from "./ports.ts";

/** How long a ticket stays good - a long review turn, not a session. */
export const TICKET_TTL_MS = 20 * 60_000;
/** Commands one turn may trigger, so a loop cannot run away with it. */
export const TICKET_USES = 5;

export type TicketContext = {
  /** Slack id the command runs as. */
  actor: string;
  channel: string;
  threadTs?: string;
};

export type CommandTickets = {
  issue: (ctx: TicketContext) => string;
  /** Resolve and spend a use. Undefined when unknown, expired or used up. */
  redeem: (token: string) => TicketContext | undefined;
};

type Entry = TicketContext & { expiresAt: number; uses: number };

export const createCommandTickets = (
  clock: Clock,
  newToken: () => string = () => crypto.randomUUID().replaceAll("-", ""),
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
      live.set(token, { ...ctx, expiresAt: now + TICKET_TTL_MS, uses: TICKET_USES });
      return token;
    },
    redeem: (token) => {
      const entry = live.get(token);
      if (!entry) return undefined;
      const now = clock();
      if (entry.expiresAt <= now) {
        live.delete(token);
        return undefined;
      }
      entry.uses -= 1;
      if (entry.uses <= 0) live.delete(token);
      return { actor: entry.actor, channel: entry.channel, threadTs: entry.threadTs };
    },
  };
};
