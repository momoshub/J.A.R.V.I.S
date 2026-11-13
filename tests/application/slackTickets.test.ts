import { describe, expect, test } from "bun:test";
import { SLACK_TICKET_TTL_MS, createSlackTickets } from "../../src/application/slackTickets.ts";

describe("Slack tickets", () => {
  test("a ticket resolves to its channel and thread, and spends a call", () => {
    const tickets = createSlackTickets(() => 0);
    const token = tickets.issue({ channel: "C1", threadTs: "1.1" });
    expect(token).toMatch(/^jvsl_[0-9a-f]{32}$/);
    const first = tickets.redeem(token);
    expect(first).toEqual({ ok: true, ctx: { channel: "C1", threadTs: "1.1" }, left: 999 });
  });

  test("a read-only ticket carries no channel", () => {
    const tickets = createSlackTickets(() => 0);
    const r = tickets.redeem(tickets.issue({}));
    expect(r.ok && r.ctx).toEqual({});
  });

  test("an unknown ticket, an empty one and a revoked one are refused", () => {
    const tickets = createSlackTickets(() => 0);
    expect(tickets.redeem("jvsl_nope")).toMatchObject({ ok: false, reason: "unknown" });
    expect(tickets.redeem("")).toMatchObject({ ok: false, reason: "unknown" });
    const token = tickets.issue({ channel: "C1" });
    tickets.revoke(token);
    expect(tickets.redeem(token)).toMatchObject({ ok: false, reason: "unknown" });
    tickets.revoke(token); // revoking twice is fine
  });

  test("an expired ticket is refused", () => {
    let now = 0;
    const tickets = createSlackTickets(() => now);
    const token = tickets.issue({ channel: "C1" });
    now = SLACK_TICKET_TTL_MS;
    expect(tickets.redeem(token)).toMatchObject({ ok: false, reason: "expired" });
  });

  test("the call budget is a runaway guard that says so", () => {
    const tickets = createSlackTickets(() => 0, undefined, 2);
    const token = tickets.issue({ channel: "C1" });
    expect(tickets.redeem(token).ok).toBe(true);
    expect(tickets.redeem(token).ok).toBe(true);
    expect(tickets.redeem(token)).toMatchObject({ ok: false, reason: "spent", limit: 2 });
  });
});
