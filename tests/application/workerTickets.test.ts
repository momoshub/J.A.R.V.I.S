import { describe, expect, test } from "bun:test";
import { createWorkerTickets, revokeOnWorkerEnd, tokenId, type WorkerTicketGrant } from "../../src/application/workerTickets.ts";
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
  let n = 0;
  const tickets = createWorkerTickets(() => t.now, () => `jvwk_tok${++n}`);
  const { token, id } = tickets.issue(grant);
  return { t, tickets, token, id };
};
const call = { action: "pr-create", repo: "o/r" };

describe("workerTickets", () => {
  test("a bound ticket resolves to the minting actor and names its dispatch", () => {
    const { tickets, token, id } = setup();
    expect(tickets.bind(id, "U0ADMIN0001", "ctx_w1")).toEqual({ ok: true });
    expect(tickets.redeem(token, call)).toEqual({ ok: true, actor: "U0ADMIN0001", channel: "C1", dispatchId: "ctx_w1", id });
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
    const { t, tickets, token, id } = setup();
    t.now += PENDING_TTL_MS + 1;
    expect(tickets.redeem(token, call)).toMatchObject({ ok: false, reason: "expired" });
    expect(tickets.bind(id, "U0ADMIN0001", "ctx_w1").ok).toBe(false);

    const fresh = tickets.issue(grant);
    t.now += 60_000;
    tickets.bind(fresh.id, "U0ADMIN0001", "ctx_w2");
    t.now += grant.ttlMs - 1;
    expect(tickets.redeem(fresh.token, call).ok).toBe(true);
    t.now += 2;
    expect(tickets.redeem(fresh.token, call)).toMatchObject({ ok: false, reason: "expired" });
  });

  test("the TTL is capped whatever the caller asked", () => {
    const { t, tickets } = setup();
    const long = tickets.issue({ ...grant, ttlMs: 100 * 60 * 60_000 });
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
    const { tickets, token, id } = setup();
    const other = tickets.issue(grant);
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
