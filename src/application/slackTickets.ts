/**
 * One-turn tickets for calling Slack through the bot.
 *
 * Same idea as `commandTickets`, and deliberately a separate store: this ticket
 * names no actor and carries no role, so it cannot run a command or act on
 * GitHub, and a command ticket cannot call Slack. All it can do is ask the
 * Slack proxy for the methods on its allowlist, writing only into the channel
 * it was minted for.
 *
 * A ticket belongs to ONE spawned process: the CLI adapter mints it when the
 * turn starts, puts it in that process's environment and revokes it when the
 * process exits, so a copy taken out of a turn is dead by the time anyone could
 * use it. The TTL is only the backstop for a revoke that never ran.
 *
 * Tickets live in memory; a restart ends every turn anyway.
 */
import type { Clock } from "./ports.ts";

/** Longer than any turn the bot allows, so a long investigation keeps its Slack access. */
export const SLACK_TICKET_TTL_MS = 3 * 60 * 60_000;
/**
 * Slack calls one turn may make. A runaway guard like the command budget, but a
 * read of a busy thread names every author with one call each, so it is much
 * higher than the command one.
 */
export const SLACK_TICKET_CALLS = 1000;

export type SlackTicketContext = {
  /** The channel writes may target; none makes the ticket read-only. */
  channel?: string;
  threadTs?: string;
};

export type SlackTicketRefusal = "unknown" | "expired" | "spent";

export type SlackTicketResult =
  | { readonly ok: true; readonly ctx: SlackTicketContext; readonly left: number }
  | { readonly ok: false; readonly reason: SlackTicketRefusal; readonly limit: number };

export type SlackTickets = {
  issue: (ctx: SlackTicketContext) => string;
  /** Resolve the ticket and spend one call. */
  redeem: (token: string) => SlackTicketResult;
  /** End it now; a ticket that is already gone is fine. */
  revoke: (token: string) => void;
};

type Entry = SlackTicketContext & { expiresAt: number; used: number };

export const createSlackTickets = (
  clock: Clock,
  newToken: () => string = () => `jvsl_${crypto.randomUUID().replaceAll("-", "")}`,
  calls: number = SLACK_TICKET_CALLS,
): SlackTickets => {
  const live = new Map<string, Entry>();

  const sweep = (now: number): void => {
    for (const [token, e] of live) if (e.expiresAt <= now) live.delete(token);
  };

  return {
    issue: (ctx) => {
      const now = clock();
      sweep(now);
      const token = newToken();
      live.set(token, { ...ctx, expiresAt: now + SLACK_TICKET_TTL_MS, used: 0 });
      return token;
    },
    redeem: (token) => {
      const entry = live.get(token);
      if (!entry) return { ok: false, reason: "unknown", limit: calls };
      if (entry.expiresAt <= clock()) {
        live.delete(token);
        return { ok: false, reason: "expired", limit: calls };
      }
      if (entry.used >= calls) return { ok: false, reason: "spent", limit: calls };
      entry.used += 1;
      return {
        ok: true,
        ctx: { ...(entry.channel ? { channel: entry.channel } : {}), ...(entry.threadTs ? { threadTs: entry.threadTs } : {}) },
        left: calls - entry.used,
      };
    },
    revoke: (token) => void live.delete(token),
  };
};
