import { describe, expect, test } from "bun:test";
import { createGithubActions } from "../../src/application/githubAppActions.ts";
import type { AllowedUser, UserRole } from "../../src/domain/types.ts";

const user = (slackId: string, role: UserRole): AllowedUser => ({ slackId, role, name: slackId }) as unknown as AllowedUser;

const setup = (role: UserRole | undefined, opts: { fail?: Error } = {}) => {
  const audit: { entry: { command: string; args: string; ok: boolean; result: string; slackUserId: string }; at: number }[] = [];
  const calls: string[] = [];
  const installs: string[] = [];
  const actions = createGithubActions({
    clock: () => 42,
    resolve: (t) => {
      if (t !== "good") throw new Error("that ticket is not valid any more");
      return { actor: "U1", channel: "C1" };
    },
    users: { get: (id) => (role && id === "U1" ? user("U1", role) : undefined) },
    github: {
      installationOfRepo: async (repo) => {
        installs.push(repo);
        if (opts.fail) throw opts.fail;
        return 7;
      },
      request: async (inst, method, path, body) => {
        calls.push(`${inst} ${method} ${path} ${JSON.stringify(body ?? null)}`);
        return { html_url: "https://github.com/o/r/pull/9", number: 9 };
      },
    },
    audit: { add: (entry, at) => void audit.push({ entry, at }) },
  });
  return { actions, audit, calls, installs };
};

const create = { action: "pr-create", repo: "o/r", head: "h", base: "master", title: "T", body: "B" };

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

  test.each(["executer", "pal"] as const)("%s is refused before anything reaches GitHub, and audited", async (role) => {
    const { actions, audit, calls, installs } = setup(role);
    await expect(actions.run({ ticket: "good", ...create })).rejects.toThrow("admin role");
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
    await expect(actions.run({ ticket: "good", ...create, actor: "OWNER", role: "owner" } as never)).rejects.toThrow("admin role");
    expect(calls).toEqual([]);
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
