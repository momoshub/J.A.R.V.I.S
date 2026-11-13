import { describe, expect, test } from "bun:test";
import { revokeOnWorkerEnd, tokenId, type WorkerTicketGrant } from "../../src/application/workerTickets.ts";
import { createWorkerTicketRepo } from "../../src/infrastructure/db/workerTicketRepo.ts";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { ticketRig } from "./workerTicketFixture.ts";
import { PENDING_TTL_MS, WORKER_LIFETIME_MAX_MS, WORKER_TTL_MAX_MS } from "../../src/domain/workerTicket.ts";
import { createCommandTickets } from "../../src/application/commandTickets.ts";

const grant: WorkerTicketGrant = {
  actor: "U0ADMIN0001",
  channel: "C1",
  threadTs: "1.1",
  repo: "o/r",
  actions: ["git-auth", "pr-create"],
  ttlMs: 3 * 60 * 60_000,
};

const setup = () => {
  const t = { now: 1000 };
  const rig = ticketRig(() => t.now);
  const { token, id } = rig.mint(grant);
  return { t, rig, tickets: rig.tickets, token, id, mint: rig.mint };
};
const call = { action: "pr-create", repo: "o/r" };

describe("workerTickets", () => {
  test("a bound ticket resolves to the minting actor and names its dispatch", () => {
    const { tickets, token, id } = setup();
    expect(tickets.bind(id, "U0ADMIN0001", "ctx_w1")).toEqual({ ok: true });
    expect(tickets.redeem(token, call)).toEqual({ ok: true, actor: "U0ADMIN0001", channel: "C1", dispatchId: "ctx_w1", id, threadTs: "1.1", push: true });
  });

  test("the id is a short hash of the token, never the token", () => {
    const { token, id } = setup();
    expect(id).toBe(tokenId(token));
    expect(id).toHaveLength(8);
    expect(token).not.toContain(id);
  });

  test("unknown and made-up tokens get nothing", () => {
    const { tickets } = setup();
    expect(tickets.redeem("jvwk_guess", call)).toMatchObject({ ok: false, reason: "unknown" });
  });

  test("not usable until bound", () => {
    const { tickets, token } = setup();
    expect(tickets.redeem(token, call)).toMatchObject({ ok: false, reason: "pending" });
  });

  test("a pending ticket lapses; binding starts the real TTL", () => {
    const { t, tickets, token, id, mint } = setup();
    t.now += PENDING_TTL_MS + 1;
    expect(tickets.redeem(token, call)).toMatchObject({ ok: false, reason: "expired" });
    expect(tickets.bind(id, "U0ADMIN0001", "ctx_w1").ok).toBe(false);

    const fresh = mint(grant);
    t.now += 60_000;
    tickets.bind(fresh.id, "U0ADMIN0001", "ctx_w2");
    t.now += grant.ttlMs - 1;
    expect(tickets.redeem(fresh.token, call).ok).toBe(true);
    t.now += 2;
    expect(tickets.redeem(fresh.token, call)).toMatchObject({ ok: false, reason: "expired" });
  });

  test("the TTL is capped whatever the caller asked", () => {
    const { t, tickets, mint } = setup();
    const long = mint({ ...grant, ttlMs: 100 * 60 * 60_000 });
    tickets.bind(long.id, "U0ADMIN0001", "ctx_w3");
    t.now += WORKER_TTL_MAX_MS + 1;
    expect(tickets.redeem(long.token, call)).toMatchObject({ ok: false, reason: "expired" });
  });

  test("an action outside the grant is refused and names what is allowed", () => {
    const { tickets, token, id } = setup();
    tickets.bind(id, "U0ADMIN0001", "ctx_w1");
    for (const action of ["pr-merge", "review", "pr-close", "comment"]) {
      const r = tickets.redeem(token, { action, repo: "o/r" });
      expect(r).toMatchObject({ ok: false, reason: "action", actor: "U0ADMIN0001", dispatchId: "ctx_w1" });
    }
  });

  test("another repo is refused; the same repo in another case is not", () => {
    const { tickets, token, id } = setup();
    tickets.bind(id, "U0ADMIN0001", "ctx_w1");
    expect(tickets.redeem(token, { action: "pr-create", repo: "o/other" })).toMatchObject({ ok: false, reason: "repo" });
    expect(tickets.redeem(token, { action: "pr-create", repo: "O/R/../x" })).toMatchObject({ ok: false, reason: "repo" });
    expect(tickets.redeem(token, { action: "pr-create", repo: "O/R" }).ok).toBe(true);
  });

  test("revoking a dispatch ends its tickets, and only its tickets", () => {
    const { tickets, token, id, mint } = setup();
    const other = mint(grant);
    tickets.bind(id, "U0ADMIN0001", "ctx_w1");
    tickets.bind(other.id, "U0ADMIN0001", "ctx_w2");
    expect(tickets.revoke("ctx_w1")).toBe(1);
    expect(tickets.revoke("ctx_w1")).toBe(0);
    expect(tickets.redeem(token, call)).toMatchObject({ ok: false, reason: "revoked" });
    expect(tickets.redeem(other.token, call).ok).toBe(true);
  });

  test("bind and revokeId belong to the minting actor", () => {
    const { tickets, token, id } = setup();
    expect(tickets.bind(id, "U0OTHER0001", "ctx_w1").ok).toBe(false);
    expect(tickets.revokeId(id, "U0OTHER0001")).toBe(false);
    expect(tickets.bind(id, "U0ADMIN0001", "ctx_w1").ok).toBe(true);
    expect(tickets.bind(id, "U0ADMIN0001", "ctx_w9").ok).toBe(false);
    expect(tickets.revokeId(id, "U0ADMIN0001")).toBe(true);
    expect(tickets.redeem(token, call)).toMatchObject({ ok: false, reason: "revoked" });
  });

  test("a worker token is not a turn ticket, and a turn ticket is not a worker token", () => {
    const { token, tickets } = setup();
    const turns = createCommandTickets(() => 1000);
    expect(turns.redeem(token).ok).toBe(false);
    const turnToken = turns.issue({ actor: "U0ADMIN0001", channel: "C1" });
    expect(tickets.redeem(turnToken, call)).toMatchObject({ ok: false, reason: "unknown" });
  });
});

describe("revokeOnWorkerEnd (the watcher's onFired)", () => {
  const helper = "/bin/orca-worker-wait.ts";
  const watch = { check: `'/bun' '${helper}' 'ctx_w1'` };
  const live = () => {
    const { tickets, token, id } = setup();
    tickets.bind(id, "U0ADMIN0001", "ctx_w1");
    return { tickets, token };
  };

  test("finished or died revokes", () => {
    for (const out of ["orca worker ctx_w1 finished: done", "orca worker ctx_w1 died: gone"]) {
      const { tickets, token } = live();
      expect(revokeOnWorkerEnd(tickets, helper)(watch, out)).toBe(1);
      expect(tickets.redeem(token, call)).toMatchObject({ ok: false, reason: "revoked" });
    }
  });

  test("waiting does not, nor does a shell watch printing the same line", () => {
    const { tickets, token } = live();
    expect(revokeOnWorkerEnd(tickets, helper)(watch, "orca worker ctx_w1 waiting: input")).toBe(0);
    expect(revokeOnWorkerEnd(tickets, helper)({ check: "echo hi" }, "orca worker ctx_w1 finished: x")).toBe(0);
    expect(revokeOnWorkerEnd(tickets, "")(watch, "orca worker ctx_w1 finished: x")).toBe(0);
    expect(tickets.redeem(token, call).ok).toBe(true);
  });
});

describe("persistence and ending", () => {
  const BOUND = { ...grant, ttlMs: 60_000 };

  test("only the hash is stored, never the token, and the token is only in its file", () => {
    const { rig, token, id } = setup();
    const row = rig.repo.byId(id);
    expect(row?.tokenHash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(rig.tokenOf(id)).toBe(token);
  });

  test("a restart keeps a bound ticket: a new store on the same database redeems it", () => {
    const db = openDatabase(":memory:");
    const t = { now: 1000 };
    const first = ticketRig(() => t.now, createWorkerTicketRepo(db));
    const { id, token } = first.mint(BOUND);
    first.tickets.bind(id, "U0ADMIN0001", "ctx_w1");
    const second = ticketRig(() => t.now, createWorkerTicketRepo(db));
    expect(second.tickets.redeem(token, call)).toMatchObject({ ok: true, dispatchId: "ctx_w1" });
    expect(second.tickets.revoke("ctx_w1")).toBe(1);
    expect(first.tickets.redeem(token, call)).toMatchObject({ ok: false, reason: "revoked" });
  });

  test("revoke deletes the token file and tells onEnd once; a second revoke does nothing", () => {
    const { rig, tickets, id } = setup();
    const ended: string[] = [];
    tickets.onEnd((i) => void ended.push(i));
    tickets.bind(id, "U0ADMIN0001", "ctx_w1");
    expect(tickets.revoke("ctx_w1")).toBe(1);
    expect(rig.files.has(id)).toBe(false);
    expect(tickets.revoke("ctx_w1")).toBe(0);
    expect(ended).toEqual([id]);
  });

  test("sweep deletes what is over for good: file gone, row gone; revoked ones are not told twice, a lapsed bound one waits for a renewal", () => {
    const { t, rig, tickets, id, mint } = setup();
    const ended: string[] = [];
    tickets.onEnd((i) => void ended.push(i));
    tickets.bind(id, "U0ADMIN0001", "ctx_w1");
    const doomed = mint(BOUND);
    tickets.bind(doomed.id, "U0ADMIN0001", "ctx_w2");
    tickets.revoke("ctx_w2");
    ended.length = 0;
    t.now += 61_000;
    expect(tickets.sweep()).toBe(1);
    expect(rig.repo.byId(doomed.id)).toBeUndefined();
    expect(ended).toEqual([]);
    expect(tickets.redeem(doomed.token, call)).toMatchObject({ ok: false, reason: "unknown" });
    // The live one lapses: its GitHub token goes (once), its row and file stay for a renewal.
    t.now += grant.ttlMs;
    expect(tickets.sweep()).toBe(0);
    expect(tickets.sweep()).toBe(0);
    expect(ended).toEqual([id]);
    expect(rig.files.has(id)).toBe(true);
    // Past the absolute lifetime nothing can revive it.
    t.now = 1000 + WORKER_LIFETIME_MAX_MS;
    expect(tickets.sweep()).toBe(1);
    expect(rig.files.size).toBe(0);
    expect(rig.repo.byId(id)).toBeUndefined();
  });

  test("an expired ticket seen at redeem lapses it, so its GitHub token is revoked (once); the row stays renewable", () => {
    const { t, tickets, token, id } = setup();
    const ended: string[] = [];
    tickets.onEnd((i) => void ended.push(i));
    tickets.bind(id, "U0ADMIN0001", "ctx_w1");
    t.now += grant.ttlMs + 1;
    expect(tickets.redeem(token, call)).toMatchObject({ ok: false, reason: "expired" });
    expect(tickets.redeem(token, call)).toMatchObject({ ok: false, reason: "expired", message: expect.stringContaining(`worker-ticket renew ${id}`) });
    expect(ended).toEqual([id]);
  });

  test("a failing onEnd listener never keeps a ticket alive", () => {
    const { tickets, token, id } = setup();
    tickets.onEnd(() => {
      throw new Error("github is down");
    });
    tickets.bind(id, "U0ADMIN0001", "ctx_w1");
    expect(tickets.revoke("ctx_w1")).toBe(1);
    expect(tickets.redeem(token, call)).toMatchObject({ ok: false, reason: "revoked" });
  });
});

describe("renewal", () => {
  const HOUR = 60 * 60_000;
  const bound = () => {
    const s = setup();
    s.tickets.bind(s.id, "U0ADMIN0001", "ctx_w1");
    return s;
  };

  test("an admin extends a live ticket to now + ttl, by id or by dispatch", () => {
    const { t, tickets, token, id } = bound();
    t.now += HOUR; // 2h of the 3h left
    const [byId] = tickets.renew(id, 3 * HOUR);
    expect(byId).toMatchObject({ ok: true, id, dispatchId: "ctx_w1", expiresAt: t.now + 3 * HOUR, ttlMs: 3 * HOUR, clamped: false, capped: false, wasExpired: false });
    t.now += 2 * HOUR + 1; // past the ORIGINAL expiry
    expect(tickets.redeem(token, call).ok).toBe(true);
    const [byDispatch] = tickets.renew("ctx_w1", HOUR);
    expect(byDispatch).toMatchObject({ ok: true });
  });

  test("a renewal never shortens a ticket", () => {
    const { t, tickets, id } = bound();
    const before = 1000 + grant.ttlMs;
    const [r] = tickets.renew(id, 10 * 60_000);
    expect(r).toMatchObject({ ok: true, expiresAt: before });
    expect(t.now).toBe(1000);
  });

  test("one renewal adds at most the per-renewal max, and says it was clamped", () => {
    const { t, tickets, id } = bound();
    const [r] = tickets.renew(id, 20 * HOUR);
    expect(r).toMatchObject({ ok: true, clamped: true, ttlMs: WORKER_TTL_MAX_MS, expiresAt: t.now + WORKER_TTL_MAX_MS });
  });

  test("an expired ticket that was never revoked is revived: same token, file kept, GitHub token reissued on use", () => {
    const { t, rig, tickets, token, id } = bound();
    const ended: string[] = [];
    tickets.onEnd((i) => void ended.push(i));
    t.now += grant.ttlMs + 1;
    expect(tickets.redeem(token, call)).toMatchObject({ ok: false, reason: "expired" });
    expect(tickets.sweep()).toBe(0);
    expect(rig.files.get(id)).toBe(token);
    const [r] = tickets.renew(id, 2 * HOUR);
    expect(r).toMatchObject({ ok: true, wasExpired: true, expiresAt: t.now + 2 * HOUR });
    expect(tickets.redeem(token, call).ok).toBe(true);
    // lapsing again tells onEnd again: it is a new life
    t.now += 2 * HOUR + 1;
    tickets.redeem(token, call);
    expect(ended).toEqual([id, id]);
  });

  test("pending, revoked and unknown tickets are refused with a clear message", () => {
    const { tickets, id, mint } = setup();
    expect(tickets.renew(id, HOUR)[0]).toMatchObject({ ok: false, error: expect.stringContaining("not bound") });
    tickets.bind(id, "U0ADMIN0001", "ctx_w1");
    tickets.revoke("ctx_w1");
    expect(tickets.renew(id, HOUR)[0]).toMatchObject({ ok: false, error: expect.stringContaining("revoked") });
    expect(tickets.renew("ctx_w1", HOUR)[0]).toMatchObject({ ok: false, error: expect.stringContaining("no worker ticket") });
    expect(tickets.renew("deadbeef", HOUR)[0]).toMatchObject({ ok: false, error: expect.stringContaining("no worker ticket") });
    expect(mint(grant).id).not.toBe(id);
  });

  test("the absolute lifetime counts from the bind: renewals are cut at it, then refused", () => {
    const { t, tickets, token, id } = bound();
    let r = tickets.renew(id, 6 * HOUR)[0];
    for (let i = 0; i < 4 && r?.ok; i++) {
      t.now += 5 * HOUR;
      r = tickets.renew(id, 6 * HOUR)[0];
    }
    const end = 1000 + WORKER_LIFETIME_MAX_MS;
    expect(r).toMatchObject({ ok: true, capped: true, expiresAt: end });
    expect(tickets.redeem(token, call).ok).toBe(true);
    expect(tickets.renew(id, HOUR)[0]).toMatchObject({ ok: true, expiresAt: end });
    t.now = end;
    expect(tickets.renew(id, HOUR)[0]).toMatchObject({ ok: false, error: expect.stringContaining("24h lifetime limit") });
    expect(tickets.redeem(token, call)).toMatchObject({ ok: false, reason: "expired", message: expect.stringContaining("24h lifetime limit") });
  });

  test("a ticket past its limit cannot be revived even if it was never swept", () => {
    const { t, tickets, id } = bound();
    t.now += WORKER_LIFETIME_MAX_MS + 1;
    expect(tickets.renew(id, HOUR)[0]).toMatchObject({ ok: false });
  });

  test("a worker renews its own live ticket, any action grant, but not an expired one", () => {
    const { t, tickets, token } = bound();
    t.now += HOUR;
    expect(tickets.renewSelf(token, 4 * HOUR)).toMatchObject({ ok: true, expiresAt: t.now + 4 * HOUR, actor: "U0ADMIN0001" });
    expect(tickets.redeem(token, { action: "ticket-renew", repo: "o/r" }).ok).toBe(true);
    expect(tickets.redeem(token, { action: "ticket-renew", repo: "o/other" })).toMatchObject({ ok: false, reason: "repo" });
    t.now += 5 * HOUR;
    expect(tickets.renewSelf(token, HOUR)).toMatchObject({ ok: false, error: expect.stringContaining("cannot renew itself"), actor: "U0ADMIN0001" });
    expect(tickets.renew("ctx_w1", HOUR)[0]).toMatchObject({ ok: true, wasExpired: true });
  });

  test("self-renew refuses pending, revoked and made-up tokens", () => {
    const { tickets, token, id } = setup();
    expect(tickets.renewSelf(token, HOUR)).toMatchObject({ ok: false, error: expect.stringContaining("not bound") });
    tickets.bind(id, "U0ADMIN0001", "ctx_w1");
    tickets.revoke("ctx_w1");
    expect(tickets.renewSelf(token, HOUR)).toMatchObject({ ok: false, error: expect.stringContaining("revoked") });
    expect(tickets.renewSelf("jvwk_guess", HOUR)).toMatchObject({ ok: false });
  });

  test("a lapsed ticket can still be revoked by its minter, so its file goes", () => {
    const { t, rig, tickets, id } = bound();
    t.now += grant.ttlMs + 1;
    expect(tickets.revokeId(id, "U0OTHER0001")).toBe(false);
    expect(tickets.revokeId(id, "U0ADMIN0001")).toBe(true);
    expect(rig.files.has(id)).toBe(false);
  });

  test("a restart keeps the bind time: the lifetime limit survives it", () => {
    const db = openDatabase(":memory:");
    const t = { now: 1000 };
    const first = ticketRig(() => t.now, createWorkerTicketRepo(db));
    const { id } = first.mint(grant);
    first.tickets.bind(id, "U0ADMIN0001", "ctx_w1");
    t.now += 10 * HOUR;
    const second = ticketRig(() => t.now, createWorkerTicketRepo(db));
    expect(second.tickets.renew(id, 6 * HOUR)[0]).toMatchObject({ ok: true });
    t.now = 1000 + WORKER_LIFETIME_MAX_MS;
    expect(second.tickets.renew(id, HOUR)[0]).toMatchObject({ ok: false });
  });
});
