import { describe, expect, test } from "bun:test";
import { createCommandTickets, TICKET_TTL_MS, TICKET_USES } from "../../src/application/commandTickets.ts";

const at = (t: { now: number }) => () => t.now;

describe("commandTickets", () => {
  test("resolves back to whoever it was issued for", () => {
    const t = { now: 1000 };
    let n = 0;
    const tickets = createCommandTickets(at(t), () => `tk${++n}`);
    const token = tickets.issue({ actor: "Upal", channel: "C1", threadTs: "9.9" });

    expect(token).toBe("tk1");
    expect(tickets.redeem(token)).toEqual({ actor: "Upal", channel: "C1", threadTs: "9.9" });
  });

  test("an unknown or made-up token gets nothing", () => {
    const tickets = createCommandTickets(at({ now: 0 }));
    expect(tickets.redeem("guessed")).toBeUndefined();
    expect(tickets.redeem("")).toBeUndefined();
  });

  test("two conversations cannot borrow each other's ticket", () => {
    const t = { now: 0 };
    let n = 0;
    const tickets = createCommandTickets(at(t), () => `tk${++n}`);
    const pal = tickets.issue({ actor: "Upal", channel: "C1" });
    const owner = tickets.issue({ actor: "Uowner", channel: "C2" });

    expect(tickets.redeem(pal)?.actor).toBe("Upal");
    expect(tickets.redeem(owner)?.actor).toBe("Uowner");
  });

  test("a turn may trigger a few commands, then the ticket is spent", () => {
    const t = { now: 0 };
    const tickets = createCommandTickets(at(t), () => "tk");
    const token = tickets.issue({ actor: "U1", channel: "C1" });

    for (let i = 0; i < TICKET_USES; i++) expect(tickets.redeem(token)).toBeDefined();
    expect(tickets.redeem(token)).toBeUndefined(); // no runaway loop
  });

  test("it expires, so a ticket left lying about is worthless", () => {
    const t = { now: 0 };
    const tickets = createCommandTickets(at(t), () => "tk");
    const token = tickets.issue({ actor: "U1", channel: "C1" });

    t.now = TICKET_TTL_MS - 1;
    expect(tickets.redeem(token)).toBeDefined();

    t.now = TICKET_TTL_MS + 1;
    expect(tickets.redeem(token)).toBeUndefined();
  });

  test("expired tickets are swept rather than accumulating", () => {
    const t = { now: 0 };
    let n = 0;
    const tickets = createCommandTickets(at(t), () => `tk${++n}`);
    const old = tickets.issue({ actor: "U1", channel: "C1" });

    t.now = TICKET_TTL_MS + 1;
    tickets.issue({ actor: "U2", channel: "C2" }); // sweeps on the way past
    expect(tickets.redeem(old)).toBeUndefined();
  });
});
