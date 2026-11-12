import { describe, expect, test } from "bun:test";
import { revokeOnWorkerEnd, tokenId, type WorkerTicketGrant } from "../../src/application/workerTickets.ts";
import { createWorkerTicketRepo } from "../../src/infrastructure/db/workerTicketRepo.ts";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { ticketRig } from "./workerTicketFixture.ts";
import { PENDING_TTL_MS, WORKER_TTL_MAX_MS } from "../../src/domain/workerTicket.ts";
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
    expect(tickets.redeem(token, call)).toEqual({ ok: true, actor: "U0ADMIN0001", channel: "C1", dispatchId: "ctx_w1", id, threadTs: "1.1" });
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

  test("sweep ends what expired: file gone, row gone, onEnd told; live ones and revoked ones are not told twice", () => {
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
    t.now += grant.ttlMs;
    expect(tickets.sweep()).toBe(1);
    expect(ended).toEqual([id]);
    expect(rig.files.size).toBe(0);
    expect(tickets.redeem(doomed.token, call)).toMatchObject({ ok: false, reason: "unknown" });
  });

  test("an expired ticket seen at redeem also ends it, so its GitHub token is revoked", () => {
    const { t, tickets, token, id } = setup();
    const ended: string[] = [];
    tickets.onEnd((i) => void ended.push(i));
    tickets.bind(id, "U0ADMIN0001", "ctx_w1");
    t.now += grant.ttlMs + 1;
    expect(tickets.redeem(token, call)).toMatchObject({ ok: false, reason: "expired" });
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
