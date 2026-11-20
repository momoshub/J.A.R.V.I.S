import { describe, expect, test } from "bun:test";
import { SLACK_TICKET_TTL_MS, createSlackTickets, slackTicketContext } from "../../src/application/slackTickets.ts";

describe("Slack tickets", () => {
  test("a ticket resolves to its channel and thread, and spends a call", () => {
    const tickets = createSlackTickets(() => 0);
    const token = tickets.issue({ channel: "C1", threadTs: "1.1" });
    expect(token).toMatch(/^jvsl_[0-9a-f]{32}$/);
    const first = tickets.redeem(token);
    expect(first).toEqual({ ok: true, ctx: { channel: "C1", threadTs: "1.1" }, left: 999 });
  });

  test("a ticket carries the turn it belongs to, when it has one", () => {
    const tickets = createSlackTickets(() => 0);
    const r = tickets.redeem(tickets.issue({ channel: "C1", threadTs: "1.1", turn: "run-1" }));
    expect(r.ok && r.ctx).toEqual({ channel: "C1", threadTs: "1.1", turn: "run-1" });
  });

  test("the owner bit is carried only when set", () => {
    const tickets = createSlackTickets(() => 0);
    const owner = tickets.redeem(tickets.issue({ channel: "C1", owner: true }));
    expect(owner.ok && owner.ctx).toEqual({ channel: "C1", owner: true });
    const other = tickets.redeem(tickets.issue({ channel: "C1", owner: false }));
    expect(other.ok && other.ctx).toEqual({ channel: "C1" });
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

describe("which run gets the owner bit", () => {
  const OWNER = "U0OWNER0001";
  const chat = { actor: OWNER, kind: "chat", channel: "C0TEST00001", threadTs: "1.1" };

  test("the owner's own message (chat, ask, btw) does", () => {
    expect(slackTicketContext({ ...chat, ownMessage: true }, "run-1", OWNER)).toEqual({ channel: "C0TEST00001", threadTs: "1.1", turn: "run-1", owner: true });
  });

  test("the dashboard draft is billed to the owner but never gets it: its prompt is a third party's thread", () => {
    const draft = { actor: OWNER, kind: "draft", channel: "C0TEST00001" };
    expect(slackTicketContext(draft, undefined, OWNER)).toEqual({ channel: "C0TEST00001" });
  });

  test("the inner child and any other owner-billed run without the flag do not either", () => {
    for (const kind of ["inner-child", "review", "investigate", "stale-promise", "follow-gate", "adapter", "chat"]) {
      const ctx = slackTicketContext({ actor: OWNER, kind, channel: "C0TEST00001" }, "run-1", OWNER);
      expect(ctx?.owner).toBeUndefined();
    }
  });

  test("the flag alone is not enough: someone else's message never gets it", () => {
    expect(slackTicketContext({ ...chat, actor: "U0USER0001", ownMessage: true }, undefined, OWNER)?.owner).toBeUndefined();
  });

  test("a run with no channel gets no ticket", () => {
    expect(slackTicketContext({ actor: OWNER, kind: "chat", ownMessage: true }, undefined, OWNER)).toBeUndefined();
    expect(slackTicketContext(undefined, undefined, OWNER)).toBeUndefined();
  });
});
