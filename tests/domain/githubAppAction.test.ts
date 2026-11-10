import { describe, expect, test } from "bun:test";
import { mayActAsApp, planAction } from "../../src/domain/githubAppAction.ts";

const ok = (req: Parameters<typeof planAction>[0]) => {
  const p = planAction(req);
  if (!p.ok) throw new Error(p.error);
  return p.calls;
};
const err = (req: Parameters<typeof planAction>[0]) => {
  const p = planAction(req);
  return p.ok ? "" : p.error;
};

describe("mayActAsApp", () => {
  test("admin and owner only", () => {
    expect(mayActAsApp("owner")).toBe(true);
    expect(mayActAsApp("admin")).toBe(true);
    expect(mayActAsApp("executer")).toBe(false);
    expect(mayActAsApp("pal")).toBe(false);
  });
});

describe("planAction request shapes", () => {
  const repo = "acme/acme-api";
  test("pr-create", () => {
    expect(ok({ action: "pr-create", repo, head: "fix/x", base: "master", title: "T", body: "B", draft: true })).toEqual([
      { method: "POST", path: `repos/${repo}/pulls`, body: { title: "T", head: "fix/x", base: "master", body: "B", draft: true } },
    ]);
    expect(ok({ action: "pr-create", repo, head: "fix/x", base: "master", title: "T" })[0]?.body).toMatchObject({ draft: false, body: "" });
  });
  test("git-auth is a plan with no REST call, and needs a valid repo", () => {
    expect(ok({ action: "git-auth", repo })).toEqual([]);
    expect(err({ action: "git-auth", repo: "nope" })).toContain("owner/name");
  });
  test("comment", () => {
    expect(ok({ action: "comment", repo, number: 5, body: "hi" })).toEqual([
      { method: "POST", path: `repos/${repo}/issues/5/comments`, body: { body: "hi" } },
    ]);
  });
  test("review", () => {
    expect(ok({ action: "review", repo, number: 5, event: "approve" })).toEqual([
      { method: "POST", path: `repos/${repo}/pulls/5/reviews`, body: { event: "APPROVE" } },
    ]);
    expect(ok({ action: "review", repo, number: 5, event: "REQUEST_CHANGES", body: "no" })[0]?.body).toEqual({
      event: "REQUEST_CHANGES",
      body: "no",
    });
  });
  test("pr-edit, close, reopen, merge", () => {
    expect(ok({ action: "pr-edit", repo, number: 5, title: "N" })[0]).toEqual({ method: "PATCH", path: `repos/${repo}/pulls/5`, body: { title: "N" } });
    expect(ok({ action: "pr-close", repo, number: 5 })[0]?.body).toEqual({ state: "closed" });
    expect(ok({ action: "pr-reopen", repo, number: 5 })[0]?.body).toEqual({ state: "open" });
    expect(ok({ action: "pr-merge", repo, number: 5 })[0]).toEqual({ method: "PUT", path: `repos/${repo}/pulls/5/merge`, body: { merge_method: "merge" } });
    expect(ok({ action: "pr-merge", repo, number: 5, method: "squash" })[0]?.body).toEqual({ merge_method: "squash" });
  });
  test("labels and reviewers", () => {
    expect(ok({ action: "labels-add", repo, number: 5, labels: ["a", "b"] })[0]).toEqual({
      method: "POST",
      path: `repos/${repo}/issues/5/labels`,
      body: { labels: ["a", "b"] },
    });
    expect(ok({ action: "labels-remove", repo, number: 5, labels: ["a b", "c"] }).map((c) => `${c.method} ${c.path}`)).toEqual([
      `DELETE repos/${repo}/issues/5/labels/a%20b`,
      `DELETE repos/${repo}/issues/5/labels/c`,
    ]);
    expect(ok({ action: "reviewers-request", repo, number: 5, reviewers: ["bob", "team:core"] })[0]?.body).toEqual({
      reviewers: ["bob"],
      team_reviewers: ["core"],
    });
  });
});

describe("planAction validation", () => {
  const repo = "o/r";
  test.each([
    [{ action: "nuke", repo }, "unknown action"],
    [{ action: "comment", repo: "nope", number: 1, body: "x" }, "owner/name"],
    [{ action: "comment", repo: "o/r/../x", number: 1, body: "x" }, "owner/name"],
    [{ action: "pr-merge", repo: "../..", number: 5 }, "owner/name"],
    [{ action: "pr-merge", repo: "../orgs", number: 5 }, "owner/name"],
    [{ action: "pr-merge", repo: "x/..", number: 5 }, "owner/name"],
    [{ action: "pr-merge", repo: "./x", number: 5 }, "owner/name"],
    [{ action: "pr-merge", repo: "x/.", number: 5 }, "owner/name"],
    [{ action: "comment", repo, number: 0, body: "x" }, "positive number"],
    [{ action: "comment", repo, number: "1; rm", body: "x" }, "positive number"],
    [{ action: "comment", repo, number: 1, body: "  " }, "non-empty"],
    [{ action: "pr-create", repo, head: "a", base: "", title: "t" }, "head, base and title"],
    [{ action: "pr-create", repo, head: "a b", base: "m", title: "t" }, "branch names"],
    [{ action: "review", repo, number: 1, event: "MERGE" }, "review event"],
    [{ action: "review", repo, number: 1, event: "COMMENT" }, "needs a body"],
    [{ action: "pr-edit", repo, number: 1 }, "title or a body"],
    [{ action: "pr-merge", repo, number: 1, method: "octopus" }, "merge method"],
    [{ action: "labels-add", repo, number: 1, labels: [] }, "at least one"],
    [{ action: "reviewers-request", repo, number: 1, reviewers: [""] }, "at least one"],
  ])("%j is refused", (req, msg) => {
    expect(err(req as Parameters<typeof planAction>[0])).toContain(msg);
  });
});
