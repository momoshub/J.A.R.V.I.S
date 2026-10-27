import { describe, expect, test } from "bun:test";
import {
  createCommandTickets,
  refusalMessage,
  TICKET_TTL_MS,
  TICKET_USES,
} from "../../src/application/commandTickets.ts";

const at = (t: { now: number }) => () => t.now;

describe("commandTickets", () => {
  test("resolves back to whoever it was issued for", () => {
    const t = { now: 1000 };
    let n = 0;
    const tickets = createCommandTickets(at(t), () => `tk${++n}`);
    const token = tickets.issue({ actor: "Upal", channel: "C1", threadTs: "9.9" });

    expect(token).toBe("tk1");
    const result = tickets.redeem(token);
    expect(result.ok).toBe(true);
    expect(result.ok && result.ctx).toEqual({ actor: "Upal", channel: "C1", threadTs: "9.9" });
  });

  test("an unknown or made-up token gets nothing", () => {
    const tickets = createCommandTickets(at({ now: 0 }));
    expect(tickets.redeem("guessed")).toEqual({ ok: false, reason: "unknown", limit: TICKET_USES });
    expect(tickets.redeem("").ok).toBe(false);
  });

  test("two conversations cannot borrow each other's ticket", () => {
    const t = { now: 0 };
    let n = 0;
    const tickets = createCommandTickets(at(t), () => `tk${++n}`);
    const pal = tickets.issue({ actor: "Upal", channel: "C1" });
    const owner = tickets.issue({ actor: "Uowner", channel: "C2" });

    const a = tickets.redeem(pal);
    const b = tickets.redeem(owner);
    expect(a.ok && a.ctx.actor).toBe("Upal");
    expect(b.ok && b.ctx.actor).toBe("Uowner");
  });

  test("the budget is big enough for real bulk work", () => {
    // it was five. Asked to delete 26 messages the bot managed five, then
    // offered to bypass the audited path entirely - a guard that stops
    // ordinary work becomes pressure to work around it
    const tickets = createCommandTickets(at({ now: 0 }), () => "tk");
    const token = tickets.issue({ actor: "U1", channel: "C1" });
    for (let i = 0; i < 30; i++) expect(tickets.redeem(token).ok).toBe(true);
  });

  test("but a runaway loop still hits a wall", () => {
    const tickets = createCommandTickets(at({ now: 0 }), () => "tk", 5);
    const token = tickets.issue({ actor: "U1", channel: "C1" });

    for (let i = 0; i < 5; i++) expect(tickets.redeem(token).ok).toBe(true);
    expect(tickets.redeem(token)).toEqual({ ok: false, reason: "spent", limit: 5 });
  });

  test("it counts down, so a turn can see the budget going", () => {
    const tickets = createCommandTickets(at({ now: 0 }), () => "tk", 3);
    const token = tickets.issue({ actor: "U1", channel: "C1" });

    const first = tickets.redeem(token);
    expect(first.ok && first.left).toBe(2);
  });

  test("a spent ticket says SPENT, not unknown", () => {
    // the old one deleted itself on the last use, so the next attempt was
    // indistinguishable from an expired ticket - the bot guessed at the cap
    // twice in one conversation and got it wrong both times
    const tickets = createCommandTickets(at({ now: 0 }), () => "tk", 1);
    const token = tickets.issue({ actor: "U1", channel: "C1" });

    tickets.redeem(token);
    const after = tickets.redeem(token);
    expect(after.ok).toBe(false);
    expect(!after.ok && after.reason).toBe("spent");
  });

  test("it expires, so a ticket left lying about is worthless", () => {
    const t = { now: 0 };
    const tickets = createCommandTickets(at(t), () => "tk");
    const token = tickets.issue({ actor: "U1", channel: "C1" });

    t.now = TICKET_TTL_MS - 1;
    expect(tickets.redeem(token).ok).toBe(true);

    t.now = TICKET_TTL_MS + 1;
    const after = tickets.redeem(token);
    expect(!after.ok && after.reason).toBe("expired");
  });

  test("expired tickets are swept rather than accumulating", () => {
    const t = { now: 0 };
    let n = 0;
    const tickets = createCommandTickets(at(t), () => `tk${++n}`);
    const old = tickets.issue({ actor: "U1", channel: "C1" });

    t.now = TICKET_TTL_MS + 1;
    tickets.issue({ actor: "U2", channel: "C2" }); // sweeps on the way past
    expect(tickets.redeem(old).ok).toBe(false);
  });
});

describe("refusalMessage", () => {
  test("a spent budget is explained, and working around it is ruled out", () => {
    const msg = refusalMessage("spent", 50);
    expect(msg).toContain("50 commands");
    expect(msg).toContain("Do NOT work around it");
  });

  test("a dead ticket is just a dead ticket", () => {
    expect(refusalMessage("expired", 50)).toContain("not valid any more");
  });
});
