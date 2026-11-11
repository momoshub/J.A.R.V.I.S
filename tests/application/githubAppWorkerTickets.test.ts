import { describe, expect, test } from "bun:test";
import { createGithubActions } from "../../src/application/githubAppActions.ts";
import { createWorkerTickets } from "../../src/application/workerTickets.ts";
import type { AllowedUser, UserRole } from "../../src/domain/types.ts";

const user = (slackId: string, role: UserRole): AllowedUser => ({ slackId, role, name: slackId }) as unknown as AllowedUser;
const TTL = 3 * 60 * 60_000;

const setup = (role: UserRole = "admin") => {
  const t = { now: 1000 };
  const tickets = createWorkerTickets(() => t.now);
  const audit: { slackUserId: string; args: string; ok: boolean; result: string }[] = [];
  const hits: string[] = [];
  const tokenScopes: (string | undefined)[] = [];
  let currentRole: UserRole | undefined = role;
  const actions = createGithubActions({
    clock: () => t.now,
    resolve: () => {
      throw new Error("a worker must never reach the turn-ticket path");
    },
    resolveWorker: tickets.redeem,
    users: { get: (id) => (currentRole && id === "U0ADMIN0001" ? user(id, currentRole) : undefined) },
    github: {
      installationOfRepo: async (repo) => {
        hits.push(`install ${repo}`);
        return 7;
      },
      installationToken: async (_inst, repo) => {
        tokenScopes.push(repo);
        return "ghs_secret_installation_token";
      },
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
    const { token, id } = tickets.issue({
      actor: "U0ADMIN0001",
      channel: "C1",
      repo: "o/r",
      actions: (over.actions ?? ["git-auth", "pr-create", "comment", "pr-edit"]) as never,
      ttlMs: TTL,
    });
    if (over.bind !== false) tickets.bind(id, "U0ADMIN0001", "ctx_w1");
    return { token, id };
  };
  return { t, tickets, actions, audit, hits, tokenScopes, mint, setRole: (r: UserRole | undefined) => void (currentRole = r) };
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

  test("git-auth works, is narrowed to the one repo, and its token is not in the audit row", async () => {
    const { actions, audit, mint, tokenScopes } = setup();
    const { token } = mint();
    const out = await actions.run({ ticket: token, action: "git-auth", repo: "o/r" });
    expect(out.github).toMatchObject({ token: "ghs_secret_installation_token", name: "jarvis[bot]" });
    expect(tokenScopes).toEqual(["o/r"]);
    expect(JSON.stringify(audit)).not.toContain("ghs_secret");
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
    setRole("pal");
    await expect(actions.run({ ticket: token, ...create })).rejects.toThrow("admin role");
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
      github: { installationOfRepo: async () => 1, installationToken: async () => "t", request: async () => ({}) },
      audit: { add: () => {} },
      allowedOwners: ["o"],
      slug: "jarvis",
    });
    await expect(actions.run({ ticket: "jvwk_x", ...create })).rejects.toThrow("not accepted");
  });
});
