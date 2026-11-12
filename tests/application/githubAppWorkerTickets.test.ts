import { describe, expect, test } from "bun:test";
import { createGithubActions } from "../../src/application/githubAppActions.ts";
import { ticketRig } from "./workerTicketFixture.ts";
import type { AllowedUser, UserRole } from "../../src/domain/types.ts";

const user = (slackId: string, role: UserRole): AllowedUser => ({ slackId, role, name: slackId }) as unknown as AllowedUser;
const TTL = 3 * 60 * 60_000;

const setup = (role: UserRole = "admin") => {
  const t = { now: 1000 };
  const rig = ticketRig(() => t.now);
  const tickets = rig.tickets;
  const redeemed: { action: string; repo: string }[] = [];
  const audit: { slackUserId: string; args: string; ok: boolean; result: string }[] = [];
  const hits: string[] = [];
  const minted: { inst: number; repo: string; token: string }[] = [];
  const revoked: string[] = [];
  const wideTokens: number[] = [];
  let expiresIn = 60 * 60_000;
  let mintError: string | undefined;
  let currentRole: UserRole | undefined = role;
  const actions = createGithubActions({
    clock: () => t.now,
    resolve: () => {
      throw new Error("a worker must never reach the turn-ticket path");
    },
    resolveWorker: (token, call) => {
      redeemed.push(call);
      return tickets.redeem(token, call);
    },
    renewWorker: (token, ttlMs) => tickets.renewSelf(token, ttlMs),
    users: { get: (id) => (currentRole && id === "U0ADMIN0001" ? user(id, currentRole) : undefined) },
    github: {
      installationOfRepo: async (repo) => {
        hits.push(`install ${repo}`);
        return 7;
      },
      installationToken: async (inst) => {
        wideTokens.push(inst);
        return "ghs_WIDE";
      },
      mintWorkerToken: async (inst, repo) => {
        if (mintError) throw new Error(mintError);
        const token = `ghs_secret_worker_${minted.length + 1}`;
        minted.push({ inst, repo, token });
        return { token, expiresAt: t.now + expiresIn };
      },
      revokeInstallationToken: async (token) => void revoked.push(token),
      request: async (_i, method, path) => {
        hits.push(`${method} ${path}`);
        return path.startsWith("users/") ? { id: 55 } : { html_url: "https://github.com/o/r/pull/3", number: 3 };
      },
    },
    audit: { add: (entry) => void audit.push(entry) },
    allowedOwners: ["o"],
    slug: "jarvis",
  });
  const mint = (over: Partial<{ actions: readonly string[]; bind: boolean }> = {}) => {
    const { token, id } = rig.mint({
      actor: "U0ADMIN0001",
      channel: "C1",
      repo: "o/r",
      actions: (over.actions ?? ["git-auth", "pr-create", "comment", "pr-edit"]) as never,
      ttlMs: TTL,
    });
    if (over.bind !== false) tickets.bind(id, "U0ADMIN0001", "ctx_w1");
    return { token, id };
  };
  return { t, tickets, actions, audit, hits, minted, revoked, wideTokens, redeemed, failMint: (m: string | undefined) => void (mintError = m), mint, setRole: (r: UserRole | undefined) => void (currentRole = r) };
};

const create = { action: "pr-create", repo: "o/r", head: "h", base: "main", title: "T", body: "B" };

describe("github app actions with a worker ticket", () => {
  test("an allowed action on its repo runs, audited with the dispatch and a short id, never the token", async () => {
    const { actions, audit, mint, hits } = setup();
    const { token, id } = mint();
    await expect(actions.run({ ticket: token, ...create })).resolves.toMatchObject({ number: 3 });
    expect(hits).toContain("POST repos/o/r/pulls");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ ok: true, slackUserId: "U0ADMIN0001" });
    expect(audit[0]?.args).toContain("worker=ctx_w1");
    expect(audit[0]?.args).toContain(`t=${id}`);
    for (const row of audit) expect(JSON.stringify(row)).not.toContain(token);
  });

  test("git-auth gives the worker its own minted token (never the wide cached one) and keeps it out of the audit row", async () => {
    const { actions, audit, mint, minted, wideTokens } = setup();
    const { token } = mint();
    const out = await actions.run({ ticket: token, action: "git-auth", repo: "o/r" });
    expect(out.github).toMatchObject({ token: "ghs_secret_worker_1", name: "jarvis[bot]" });
    expect(minted).toEqual([{ inst: 7, repo: "o/r", token: "ghs_secret_worker_1" }]);
    expect(wideTokens).toEqual([]);
    expect(JSON.stringify(audit)).not.toContain("ghs_secret");
  });

  test("a ticket reuses its own token until near expiry, then rotates and revokes the old one", async () => {
    const { actions, mint, minted, revoked, t } = setup();
    const { token } = mint();
    const git = () => actions.run({ ticket: token, action: "git-auth", repo: "o/r" });
    await git();
    await git();
    expect(minted).toHaveLength(1);
    t.now += 56 * 60_000;
    await git();
    expect(minted).toHaveLength(2);
    expect(revoked).toEqual(["ghs_secret_worker_1"]);
  });

  test("two tickets on the same repo never share a token, and ending one revokes only its own", async () => {
    const { actions, mint, minted, revoked, tickets } = setup();
    const a = mint();
    const b = mint();
    tickets.bind(b.id, "U0ADMIN0001", "ctx_w2");
    await actions.run({ ticket: a.token, action: "git-auth", repo: "o/r" });
    await actions.run({ ticket: b.token, action: "git-auth", repo: "o/r" });
    expect(new Set(minted.map((m) => m.token)).size).toBe(2);
    await actions.endWorker(a.id);
    expect(revoked).toEqual(["ghs_secret_worker_1"]);
    await actions.endWorker(a.id);
    expect(revoked).toHaveLength(1);
  });

  test("a ticket that ends has its GitHub token revoked, and a later git-auth is refused", async () => {
    const { actions, mint, minted, revoked, tickets } = setup();
    const { token } = mint();
    await actions.run({ ticket: token, action: "git-auth", repo: "o/r" });
    tickets.onEnd((i) => void actions.endWorker(i));
    tickets.revoke("ctx_w1");
    await Promise.resolve();
    await Promise.resolve();
    expect(revoked).toEqual(minted.map((m) => m.token));
    await expect(actions.run({ ticket: token, action: "git-auth", repo: "o/r" })).rejects.toThrow("revoked");
    expect(minted).toHaveLength(1);
  });

  test("a failed mint (no contents permission) is the error and holds nothing, so the next call tries again", async () => {
    const { actions, mint, minted, failMint } = setup();
    const { token } = mint();
    failMint("the app has no contents permission on this installation");
    await expect(actions.run({ ticket: token, action: "git-auth", repo: "o/r" })).rejects.toThrow("no contents permission");
    failMint(undefined);
    await expect(actions.run({ ticket: token, action: "git-auth", repo: "o/r" })).resolves.toBeDefined();
    expect(minted).toHaveLength(1);
  });

  test("another action is refused before GitHub is touched, and audited", async () => {
    const { actions, audit, mint, hits } = setup();
    const { token } = mint();
    for (const action of ["pr-merge", "review", "pr-close", "labels-add"]) {
      await expect(actions.run({ ticket: token, action, repo: "o/r", number: 3, event: "APPROVE", labels: ["x"] })).rejects.toThrow("does not allow");
    }
    expect(hits).toEqual([]);
    expect(audit).toHaveLength(4);
    expect(audit.every((r) => !r.ok && r.args.includes("worker=ctx_w1"))).toBe(true);
  });

  test("another repo is refused, even one the actor could reach", async () => {
    const { actions, mint, hits } = setup();
    const { token } = mint();
    await expect(actions.run({ ticket: token, ...create, repo: "o/other" })).rejects.toThrow("o/r only");
    await expect(actions.run({ ticket: token, action: "git-auth", repo: "o/other" })).rejects.toThrow("o/r only");
    expect(hits).toEqual([]);
  });

  test("scope is checked against what the plan will run, not the raw request", async () => {
    const { actions, mint, redeemed, hits } = setup();
    const { token } = mint();
    await actions.run({ ticket: token, ...create, repo: " O/r " });
    expect(redeemed.at(-1)).toEqual({ action: "pr-create", repo: "O/r" });
    expect(hits).toContain("POST repos/O/r/pulls");
    await expect(actions.run({ ticket: token, ...create, repo: " o/other " })).rejects.toThrow("o/r only, not o/other");
    expect(redeemed.at(-1)).toEqual({ action: "pr-create", repo: "o/other" });
  });

  test("a request the plan rejects is refused whatever the ticket allows, with the ticket still audited", async () => {
    const { actions, mint, audit } = setup();
    const { token } = mint();
    await expect(actions.run({ ticket: token, action: "pr-create", repo: "o/r" })).rejects.toThrow("pr-create needs head");
    expect(audit.at(-1)).toMatchObject({ ok: false, slackUserId: "U0ADMIN0001" });
    expect(audit.at(-1)?.args).toContain("worker=ctx_w1");
    await expect(actions.run({ ticket: token, action: { x: 1 } as never, repo: "o/r" })).rejects.toThrow("does not allow");
  });

  test("an unbound ticket waits, an expired one is gone", async () => {
    const { actions, mint, t } = setup();
    const pending = mint({ bind: false });
    await expect(actions.run({ ticket: pending.token, ...create })).rejects.toThrow("not bound");
    const bound = mint();
    t.now += TTL + 1;
    await expect(actions.run({ ticket: bound.token, ...create })).rejects.toThrow("expired");
  });

  test("revoked when its worker ends", async () => {
    const { actions, mint, tickets, audit } = setup();
    const { token } = mint();
    tickets.revoke("ctx_w1");
    await expect(actions.run({ ticket: token, ...create })).rejects.toThrow("revoked");
    expect(audit.at(-1)).toMatchObject({ ok: false });
  });

  test("the role of the minting actor is checked on every call, not only at mint", async () => {
    const { actions, mint, setRole, hits } = setup("admin");
    const { token } = mint();
    await expect(actions.run({ ticket: token, ...create })).resolves.toBeDefined();
    setRole("executer");
    await expect(actions.run({ ticket: token, ...create })).rejects.toThrow("admin or the owner");
    setRole("pal");
    await expect(actions.run({ ticket: token, ...create })).rejects.toThrow("admin or the owner");
    setRole(undefined);
    await expect(actions.run({ ticket: token, ...create })).rejects.toThrow("not on the access list");
    expect(hits.filter((h) => h === "POST repos/o/r/pulls")).toHaveLength(1);
  });

  test("an unknown worker token is refused and never falls through to the turn-ticket path", async () => {
    const { actions } = setup();
    await expect(actions.run({ ticket: "jvwk_guess", ...create })).rejects.toThrow("not valid");
  });

  test("an instance without worker tickets refuses them", async () => {
    const actions = createGithubActions({
      clock: () => 1,
      resolve: () => ({ actor: "U0ADMIN0001", channel: "C1" }),
      users: { get: () => user("U0ADMIN0001", "owner") },
      github: {
        installationOfRepo: async () => 1,
        installationToken: async () => "t",
        mintWorkerToken: async () => ({ token: "t", expiresAt: 1 }),
        revokeInstallationToken: async () => {},
        request: async () => ({}),
      },
      audit: { add: () => {} },
      allowedOwners: ["o"],
      slug: "jarvis",
    });
    await expect(actions.run({ ticket: "jvwk_x", ...create })).rejects.toThrow("not accepted");
  });
});

describe("ticket-renew with a worker ticket", () => {
  const renew = { action: "ticket-renew", repo: "o/r" };

  test("extends the worker's own ticket without touching GitHub, and audits it like any call", async () => {
    const { t, tickets, actions, audit, hits, mint } = setup();
    const { token, id } = mint({ actions: ["comment"] }); // renewing needs no grant
    t.now += 2 * 60 * 60_000;
    const out = await actions.run({ ticket: token, ...renew, ttl: "5h" });
    expect(out.github).toMatchObject({ renewed: { id, ttlMs: 5 * 60 * 60_000, clamped: false, capped: false } });
    expect(hits).toEqual([]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ ok: true, slackUserId: "U0ADMIN0001" });
    expect(audit[0]?.args).toContain("ticket-renew o/r ttl=5h worker=ctx_w1");
    expect(audit[0]?.result).toContain(`ticket ${id} renewed`);
    t.now += 4 * 60 * 60_000; // past the original 3h expiry
    expect(tickets.redeem(token, { action: "comment", repo: "o/r" }).ok).toBe(true);
  });

  test("the default ttl is 3h and a longer one is clamped to 6h, and the answer says so", async () => {
    const { t, actions, mint } = setup();
    const { token } = mint();
    const dflt = await actions.run({ ticket: token, ...renew });
    expect(dflt.github).toMatchObject({ renewed: { ttlMs: TTL } });
    const long = await actions.run({ ticket: token, ...renew, ttl: "20h" });
    expect(long.github).toMatchObject({ renewed: { clamped: true, ttlMs: 6 * 60 * 60_000, expiresAt: t.now + 6 * 60 * 60_000 } });
    expect(JSON.stringify(long.github)).toContain("clamped");
  });

  test("an expired ticket cannot renew itself, and the refusal is audited", async () => {
    const { t, actions, audit, mint, tickets } = setup();
    const { token, id } = mint();
    t.now += TTL + 1;
    await expect(actions.run({ ticket: token, ...renew })).rejects.toThrow("expired");
    expect(audit[0]).toMatchObject({ ok: false });
    // ... but its admin can still revive it, and then it works again
    expect(tickets.renew(id, TTL)[0]).toMatchObject({ ok: true, wasExpired: true });
    await expect(actions.run({ ticket: token, ...renew })).resolves.toBeDefined();
  });

  test("pending, revoked, wrong-repo and bad-ttl calls are refused", async () => {
    const { actions, mint, tickets } = setup();
    const pending = mint({ bind: false });
    await expect(actions.run({ ticket: pending.token, ...renew })).rejects.toThrow("not bound");
    const { token } = mint();
    await expect(actions.run({ ticket: token, action: "ticket-renew", repo: "o/other" })).rejects.toThrow("o/r only");
    await expect(actions.run({ ticket: token, ...renew, ttl: "soon" })).rejects.toThrow("ttl wants a duration");
    tickets.revoke("ctx_w1");
    await expect(actions.run({ ticket: token, ...renew })).rejects.toThrow("revoked");
  });

  test("a demoted minter cannot renew, and nothing is extended", async () => {
    const { t, actions, mint, setRole, tickets } = setup();
    const { token } = mint();
    setRole("executer");
    await expect(actions.run({ ticket: token, ...renew })).rejects.toThrow("admin or the owner");
    setRole("admin");
    t.now += TTL + 1;
    expect(tickets.redeem(token, { action: "comment", repo: "o/r" })).toMatchObject({ ok: false, reason: "expired" });
  });

  test("past the absolute lifetime it is refused and says so", async () => {
    const { t, actions, mint } = setup();
    const { token } = mint();
    for (let i = 0; i < 4; i++) {
      t.now += 5 * 60 * 60_000;
      await actions.run({ ticket: token, ...renew, ttl: "6h" }).catch(() => undefined);
    }
    t.now += 5 * 60 * 60_000;
    await expect(actions.run({ ticket: token, ...renew })).rejects.toThrow("24h lifetime limit");
  });
});
