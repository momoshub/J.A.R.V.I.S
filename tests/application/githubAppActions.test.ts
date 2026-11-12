import { describe, expect, test } from "bun:test";
import { createGithubActions, type GithubActionDeps } from "../../src/application/githubAppActions.ts";
import type { AllowedUser, UserRole } from "../../src/domain/types.ts";
import { staticBook, type Role, type RoleBook } from "../../src/domain/roles.ts";
import { seededBook } from "../../src/domain/roleSeed.ts";

const user = (slackId: string, role: UserRole): AllowedUser => ({ slackId, role, name: slackId }) as unknown as AllowedUser;

type SetupOpts = {
  fail?: Error;
  threadTs?: string;
  onPrCreated?: (pr: { url: string; channelId: string; threadTs: string }) => void;
  resolveWorker?: GithubActionDeps["resolveWorker"];
  roles?: RoleBook;
};

const setup = (role: UserRole | undefined, opts: SetupOpts = {}) => {
  const audit: { entry: { command: string; args: string; ok: boolean; result: string; slackUserId: string }; at: number }[] = [];
  const calls: string[] = [];
  const installs: string[] = [];
  const actions = createGithubActions({
    clock: () => 42,
    resolve: (t) => {
      if (t !== "good") throw new Error("that ticket is not valid any more");
      return { actor: "U1", channel: "C1", ...(opts.threadTs ? { threadTs: opts.threadTs } : {}) };
    },
    users: { get: (id) => (role && id === "U1" ? user("U1", role) : undefined) },
    github: {
      installationOfRepo: async (repo) => {
        installs.push(repo);
        if (opts.fail) throw opts.fail;
        return 7;
      },
      installationToken: async (inst) => `tok-${inst}`,
      mintWorkerToken: async (inst) => ({ token: `worker-${inst}`, expiresAt: 1 }),
      revokeInstallationToken: async () => {},
      request: async (inst, method, path, body) => {
        if (path.startsWith("users/")) {
          calls.push(`${inst} ${method} ${path}`);
          return { id: 1234 };
        }
        calls.push(`${inst} ${method} ${path} ${JSON.stringify(body ?? null)}`);
        return { html_url: "https://github.com/o/r/pull/9", number: 9 };
      },
    },
    audit: { add: (entry, at) => void audit.push({ entry, at }) },
    ...(opts.roles ? { roles: opts.roles } : {}),
    ...(opts.onPrCreated ? { onPrCreated: opts.onPrCreated } : {}),
    ...(opts.resolveWorker ? { resolveWorker: opts.resolveWorker } : {}),
    allowedOwners: ["o"],
    slug: "jarvis-at-acme",
  });
  return { actions, audit, calls, installs };
};

const create = { action: "pr-create", repo: "o/r", head: "h", base: "master", title: "T", body: "B" };

describe("github app actions: PR -> thread record", () => {
  test("a PR opened from a thread is reported with that thread", async () => {
    const seen: unknown[] = [];
    const { actions } = setup("admin", { threadTs: "100.2", onPrCreated: (pr) => seen.push(pr) });
    await actions.run({ ticket: "good", ...create });
    expect(seen).toEqual([{ url: "https://github.com/o/r/pull/9", channelId: "C1", threadTs: "100.2" }]);
  });

  test("nothing is recorded without a thread, for another action, or when the recorder throws", async () => {
    const seen: unknown[] = [];
    const noThread = setup("admin", { onPrCreated: (pr) => seen.push(pr) });
    await noThread.actions.run({ ticket: "good", ...create });
    const comment = setup("admin", { threadTs: "1.1", onPrCreated: (pr) => seen.push(pr) });
    await comment.actions.run({ ticket: "good", action: "comment", repo: "o/r", number: 9, body: "hi" });
    expect(seen).toEqual([]);
    const boom = setup("admin", { threadTs: "1.1", onPrCreated: () => { throw new Error("disk"); } });
    await expect(boom.actions.run({ ticket: "good", ...create })).resolves.toMatchObject({ number: 9 });
  });

  test("a worker's PR is recorded with the thread its ticket was minted in", async () => {
    const seen: unknown[] = [];
    const resolveWorker: GithubActionDeps["resolveWorker"] = () => ({ ok: true, actor: "U1", channel: "C7", dispatchId: "ctx_w1", id: "wk1", threadTs: "700.7" });
    const { actions } = setup("admin", { resolveWorker, onPrCreated: (pr) => seen.push(pr) });
    await actions.run({ ticket: "jvwk_test", ...create });
    expect(seen).toEqual([{ url: "https://github.com/o/r/pull/9", channelId: "C7", threadTs: "700.7" }]);
  });
});

describe("github app actions: auth gate", () => {
  test.each(["admin", "owner"] as const)("%s may act, and it is audited", async (role) => {
    const { actions, audit, calls, installs } = setup(role);
    const out = await actions.run({ ticket: "good", ...create });
    expect(out).toMatchObject({ url: "https://github.com/o/r/pull/9", number: 9 });
    expect(installs).toEqual(["o/r"]);
    expect(calls).toEqual([`7 POST repos/o/r/pulls ${JSON.stringify({ title: "T", head: "h", base: "master", body: "B", draft: false })}`]);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.entry).toMatchObject({ command: "github-app", ok: true, slackUserId: "U1" });
    expect(audit[0]?.entry.args).toContain("pr-create o/r");
    expect(audit[0]?.entry.args).not.toContain("B");
  });

  test.each(["pal"] as const)("%s is refused before anything reaches GitHub, and audited", async (role) => {
    const { actions, audit, calls, installs } = setup(role);
    await expect(actions.run({ ticket: "good", ...create })).rejects.toThrow("may not act on GitHub as the app");
    expect(calls).toEqual([]);
    expect(installs).toEqual([]);
    expect(audit[0]?.entry).toMatchObject({ ok: false });
  });

  test("somebody off the access list is refused", async () => {
    const { actions, calls } = setup(undefined);
    await expect(actions.run({ ticket: "good", ...create })).rejects.toThrow("access list");
    expect(calls).toEqual([]);
  });

  test("a missing ticket is refused", async () => {
    const { actions, calls } = setup("owner");
    await expect(actions.run({ ticket: "", ...create })).rejects.toThrow("no ticket");
    await expect(actions.run({ ticket: "   ", ...create })).rejects.toThrow("no ticket");
    expect(calls).toEqual([]);
  });

  test("an unknown ticket is refused", async () => {
    const { actions, calls } = setup("owner");
    await expect(actions.run({ ticket: "forged", ...create })).rejects.toThrow("not valid");
    expect(calls).toEqual([]);
  });

  test("the role is the ticket's actor's, never anything in the request", async () => {
    const { actions, calls } = setup("pal");
    await expect(actions.run({ ticket: "good", ...create, actor: "OWNER", role: "owner" } as never)).rejects.toThrow("may not act on GitHub as the app");
    expect(calls).toEqual([]);
  });
});

describe("github app actions: scope and audit", () => {
  test("an owner outside the allowlist is refused before the installation lookup", async () => {
    const { actions, installs, calls, audit } = setup("owner");
    await expect(actions.run({ ticket: "good", ...create, repo: "stranger/r" })).rejects.toThrow("GITHUB_APP_ALLOWED_OWNERS");
    expect(installs).toEqual([]);
    expect(calls).toEqual([]);
    expect(audit[0]?.entry.ok).toBe(false);
  });

  test("the owner match ignores case", async () => {
    const { actions, installs } = setup("owner");
    await actions.run({ ticket: "good", ...create, repo: "O/r" });
    expect(installs).toEqual(["O/r"]);
  });

  test("the audit row names what was acted on, never the body", async () => {
    const { actions, audit } = setup("admin");
    await actions.run({ ticket: "good", action: "labels-add", repo: "o/r", number: 5, labels: ["bug", "p1"] });
    await actions.run({ ticket: "good", action: "reviewers-request", repo: "o/r", number: 5, reviewers: ["bob", "team:core"] });
    await actions.run({ ticket: "good", ...create, body: "SECRET BODY", draft: true });
    await actions.run({ ticket: "good", action: "pr-edit", repo: "o/r", number: 5, title: "New", body: "SECRET BODY" });
    const args = audit.map((a) => a.entry.args);
    expect(args[0]).toBe("labels-add o/r 5 labels=bug,p1");
    expect(args[1]).toBe("reviewers-request o/r 5 reviewers=bob,team:core");
    expect(args[2]).toContain("draft=true");
    expect(args[2]).toContain("head=h base=master");
    expect(args[3]).toContain("body=changed");
    expect(args.join("\n")).not.toContain("SECRET");
  });
});

describe("github app actions: behaviour", () => {
  test("bad arguments are refused and audited without calling GitHub", async () => {
    const { actions, audit, installs } = setup("admin");
    await expect(actions.run({ ticket: "good", action: "review", repo: "o/r", number: 1, event: "COMMENT" })).rejects.toThrow("needs a body");
    expect(installs).toEqual([]);
    expect(audit[0]?.entry.ok).toBe(false);
  });

  test("a multi-call action (labels-remove) makes every call and returns the list", async () => {
    const { actions, calls } = setup("admin");
    const out = await actions.run({ ticket: "good", action: "labels-remove", repo: "o/r", number: 3, labels: ["a", "b"] });
    expect(calls).toHaveLength(2);
    expect(Array.isArray(out.github)).toBe(true);
  });

  test("GitHub's refusal comes back plainly and is audited", async () => {
    const { actions, audit } = setup("admin", { fail: new Error("GitHub GET repos/o/r/installation -> 404: Not Found") });
    await expect(actions.run({ ticket: "good", ...create })).rejects.toThrow("404: Not Found");
    expect(audit[0]?.entry).toMatchObject({ ok: false });
    expect(audit[0]?.entry.result).toContain("404");
  });
});

describe("github app actions: git-auth", () => {
  test("hands back the token and the bot identity, looked up once, and audits without the token", async () => {
    const { actions, audit, calls } = setup("admin");
    const out = await actions.run({ ticket: "good", action: "git-auth", repo: "o/r" });
    expect(out.github).toEqual({
      token: "tok-7",
      name: "jarvis-at-acme[bot]",
      email: "1234+jarvis-at-acme[bot]@users.noreply.github.com",
    });
    await actions.run({ ticket: "good", action: "git-auth", repo: "o/r" });
    expect(calls).toEqual(["7 GET users/jarvis-at-acme%5Bbot%5D"]);
    expect(audit.map((a) => a.entry.args)).toEqual(["git-auth o/r", "git-auth o/r"]);
    expect(JSON.stringify(audit)).not.toContain("tok-7");
  });

  test("a pal is refused and gets no token", async () => {
    const { actions, installs } = setup("pal");
    await expect(actions.run({ ticket: "good", action: "git-auth", repo: "o/r" })).rejects.toThrow("may not act on GitHub as the app");
    expect(installs).toEqual([]);
  });

  test("an executer gets the bot identity with an EMPTY token, so it commits as the app but cannot push", async () => {
    const { actions, calls } = setup("executer");
    const out = (await actions.run({ ticket: "good", action: "git-auth", repo: "o/r" })) as { github: { token: string; name: string } };
    expect(out.github.token).toBe("");
    expect(out.github.name).toBe("jarvis-at-acme[bot]");
    expect(calls).toEqual(["7 GET users/jarvis-at-acme%5Bbot%5D"]);
    await expect(actions.run({ ticket: "good", action: "git-auth", repo: "o/r", purpose: "push" })).rejects.toThrow("github:push");
  });

  test("an executer may open and edit PRs, comment, label and ask for reviewers - not merge, review, close or remove labels", async () => {
    const { actions } = setup("executer");
    await expect(actions.run({ ticket: "good", ...create })).resolves.toMatchObject({ number: 9 });
    for (const action of ["pr-merge", "review", "pr-close", "pr-reopen", "labels-remove"]) {
      await expect(actions.run({ ticket: "good", action, repo: "o/r", number: 9, event: "APPROVE", labels: ["x"], method: "merge" })).rejects.toThrow("may not act on GitHub as the app");
    }
  });

  test("an owner outside the allowlist gets no token", async () => {
    const { actions, installs } = setup("owner");
    await expect(actions.run({ ticket: "good", action: "git-auth", repo: "stranger/r" })).rejects.toThrow("GITHUB_APP_ALLOWED_OWNERS");
    expect(installs).toEqual([]);
  });
});

/** The seeded roles plus a custom one holding exactly `grants`: what an owner does with `role grant`. */
const withRole = (name: string, grants: string[]): RoleBook =>
  staticBook([...seededBook().list().filter((r) => r.name !== "owner"), { name, rank: 1, description: "", enabled: true, grants, deniedTools: [] } as Role]);

describe("github app actions: every action is its own grant", () => {
  test("a role holding github:comment may comment and nothing else, and is refused (audited) for the rest", async () => {
    const roles = withRole("triager", ["github:comment"]);
    const { actions, calls, audit } = setup("triager", { roles });
    await expect(actions.run({ ticket: "good", action: "comment", repo: "o/r", number: 9, body: "hi" })).resolves.toBeDefined();
    expect(calls).toHaveLength(1);
    await expect(actions.run({ ticket: "good", action: "pr-merge", repo: "o/r", number: 9 })).rejects.toThrow("github:pr-merge");
    await expect(actions.run({ ticket: "good", ...create })).rejects.toThrow("github:pr-create");
    expect(calls).toHaveLength(1);
    expect(audit.at(-1)?.entry).toMatchObject({ ok: false });
  });

  test("granting an executer more is all it takes - no code change", async () => {
    const roles = staticBook(
      seededBook().list().filter((r) => r.name !== "owner").map((r) => (r.name === "executer" ? { ...r, grants: [...r.grants, "github:pr-merge"] } : r)),
    );
    const { actions } = setup("executer", { roles });
    await expect(actions.run({ ticket: "good", action: "pr-merge", repo: "o/r", number: 9 })).resolves.toBeDefined();
    await expect(actions.run({ ticket: "good", action: "pr-close", repo: "o/r", number: 9 })).rejects.toThrow("may not act on GitHub as the app");
  });

  test("git and push are separate grants for the same token", async () => {
    const gitOnly = setup("g", { roles: withRole("g", ["github:git"]) });
    await expect(gitOnly.actions.run({ ticket: "good", action: "git-auth", repo: "o/r" })).resolves.toBeDefined();
    await expect(gitOnly.actions.run({ ticket: "good", action: "git-auth", repo: "o/r", purpose: "push" })).rejects.toThrow("github:push");
    const pushOnly = setup("p", { roles: withRole("p", ["github:push"]) });
    await expect(pushOnly.actions.run({ ticket: "good", action: "git-auth", repo: "o/r", purpose: "push" })).resolves.toBeDefined();
    await expect(pushOnly.actions.run({ ticket: "good", action: "git-auth", repo: "o/r" })).rejects.toThrow("github:git");
  });

  test("a role switched off, or removed, holds nothing", async () => {
    const off = staticBook(seededBook().list().filter((r) => r.name !== "owner").map((r) => (r.name === "admin" ? { ...r, enabled: false } : r)));
    await expect(setup("admin", { roles: off }).actions.run({ ticket: "good", ...create })).rejects.toThrow("may not act on GitHub as the app");
    await expect(setup("ghost", { roles: off }).actions.run({ ticket: "good", ...create })).rejects.toThrow("may not act on GitHub as the app");
  });
});
