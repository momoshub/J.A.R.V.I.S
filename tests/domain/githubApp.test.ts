import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  detectActivity,
  detectTrigger,
  githubTurnPrompt,
  isAllowedOwner,
  mentions,
  parseAllowedOwners,
  toGithubComment,
  unknownSenderComment,
  verifySignature,
} from "../../src/domain/githubApp.ts";

const OPTS = { slug: "jarvis-at-acme", label: "jarvis" };
const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const base = (over: Record<string, unknown> = {}) => ({
  repository: { full_name: "acme/api", owner: { login: "acme" } },
  installation: { id: 42 },
  sender: { login: "dev-gh", type: "User" },
  ...over,
});

const issueComment = (body: string, over: Record<string, unknown> = {}) =>
  base({
    action: "created",
    issue: { number: 7, title: "broken thing", html_url: "https://github.com/acme/api/issues/7" },
    comment: { id: 99, body, html_url: "https://github.com/acme/api/issues/7#issuecomment-99" },
    ...over,
  });

describe("verifySignature", () => {
  const body = '{"a":1}';
  test("accepts the HMAC of the raw body", () => {
    expect(verifySignature("s3cret", body, sign("s3cret", body))).toBe(true);
  });
  test("rejects a wrong secret, a tampered body, a missing or malformed header", () => {
    expect(verifySignature("other", body, sign("s3cret", body))).toBe(false);
    expect(verifySignature("s3cret", '{"a":2}', sign("s3cret", body))).toBe(false);
    expect(verifySignature("s3cret", body, null)).toBe(false);
    expect(verifySignature("s3cret", body, "sha1=abc")).toBe(false);
    expect(verifySignature("", body, sign("", body))).toBe(false);
  });
});

describe("owner allowlist", () => {
  test("is case-insensitive and ignores blanks", () => {
    const allowed = parseAllowedOwners(" Acme, ,kai-at-acme ");
    expect(allowed).toEqual(["acme", "kai-at-acme"]);
    expect(isAllowedOwner("acme", [])).toBe(false);
    expect(isAllowedOwner("acme", allowed)).toBe(true);
    expect(isAllowedOwner("Acme", allowed)).toBe(true);
    expect(isAllowedOwner("stranger", allowed)).toBe(false);
    expect(isAllowedOwner("", allowed)).toBe(false);
  });
});

describe("mentions", () => {
  test("a whole-word @slug only", () => {
    expect(mentions("@jarvis-at-acme please look", OPTS.slug)).toBe(true);
    expect(mentions("hey (@Jarvis-At-Acme)", OPTS.slug)).toBe(true);
    expect(mentions("@jarvis-at-acme-two", OPTS.slug)).toBe(false);
    expect(mentions("mail@jarvis-at-acme", OPTS.slug)).toBe(false);
    expect(mentions("jarvis-at-acme", OPTS.slug)).toBe(false);
  });
});

describe("detectTrigger", () => {
  test("an issue comment mentioning the app", () => {
    const d = detectTrigger("issue_comment", "d1", issueComment("@jarvis-at-acme why?"), OPTS);
    expect(d.kind).toBe("trigger");
    if (d.kind !== "trigger") return;
    expect(d.trigger).toMatchObject({
      deliveryId: "d1",
      repo: "acme/api",
      owner: "acme",
      number: 7,
      isPr: false,
      installationId: 42,
      sender: "dev-gh",
      via: "mention",
      reactionPath: "repos/acme/api/issues/comments/99/reactions",
    });
  });

  test("a PR conversation comment is a PR", () => {
    const p = issueComment("@jarvis-at-acme", {
      issue: { number: 8, title: "t", html_url: "u", pull_request: { url: "x" } },
    });
    const d = detectTrigger("issue_comment", "d", p, OPTS);
    expect(d.kind === "trigger" && d.trigger.isPr).toBe(true);
  });

  test("a comment without the mention is ignored", () => {
    expect(detectTrigger("issue_comment", "d", issueComment("just chatting"), OPTS).kind).toBe("ignore");
  });

  test("a review comment and a submitted review", () => {
    const rc = detectTrigger(
      "pull_request_review_comment",
      "d",
      base({ action: "created", pull_request: { number: 3, title: "t", html_url: "u" }, comment: { id: 5, body: "@jarvis-at-acme nit?" } }),
      OPTS,
    );
    expect(rc.kind === "trigger" && rc.trigger.reactionPath).toBe("repos/acme/api/pulls/comments/5/reactions");
    const rv = detectTrigger(
      "pull_request_review",
      "d",
      base({ action: "submitted", pull_request: { number: 3, title: "t", html_url: "u" }, review: { body: "@jarvis-at-acme check" } }),
      OPTS,
    );
    expect(rv.kind).toBe("trigger");
    if (rv.kind === "trigger") {
      expect(rv.trigger.isPr).toBe(true);
      expect(rv.trigger.reactionPath).toBeUndefined();
    }
  });

  test("the trigger label on an issue or PR, and no other label", () => {
    const issue = detectTrigger(
      "issues",
      "d",
      base({ action: "labeled", label: { name: "Jarvis" }, issue: { number: 4, title: "t", html_url: "u", body: "do it" } }),
      OPTS,
    );
    expect(issue.kind === "trigger" && issue.trigger.via).toBe("label");
    expect(issue.kind === "trigger" && issue.trigger.body).toBe("do it");
    const pr = detectTrigger(
      "pull_request",
      "d",
      base({ action: "labeled", label: { name: "jarvis" }, pull_request: { number: 9, title: "t", html_url: "u" } }),
      OPTS,
    );
    expect(pr.kind === "trigger" && pr.trigger.isPr).toBe(true);
    const other = detectTrigger(
      "issues",
      "d",
      base({ action: "labeled", label: { name: "bug" }, issue: { number: 4, title: "t", html_url: "u" } }),
      OPTS,
    );
    expect(other.kind).toBe("ignore");
  });

  test("bots, the app itself included, never trigger it", () => {
    const bot = issueComment("@jarvis-at-acme", { sender: { login: "dependabot[bot]", type: "Bot" } });
    expect(detectTrigger("issue_comment", "d", bot, OPTS).kind).toBe("ignore");
    const self = issueComment("@jarvis-at-acme", { sender: { login: "jarvis-at-acme[bot]", type: "User" } });
    expect(detectTrigger("issue_comment", "d", self, OPTS).kind).toBe("ignore");
  });

  test("other events and edits are not triggers", () => {
    expect(detectTrigger("issue_comment", "d", issueComment("@jarvis-at-acme", { action: "edited" }), OPTS).kind).toBe("ignore");
    expect(detectTrigger("push", "d", base({}), OPTS).kind).toBe("ignore");
    expect(detectTrigger("issue_comment", "d", null, OPTS).kind).toBe("ignore");
  });
});

describe("what it writes", () => {
  test("the turn prompt carries the context and the helper", () => {
    const d = detectTrigger("issue_comment", "d1", issueComment("@jarvis-at-acme why?"), OPTS);
    if (d.kind !== "trigger") throw new Error("expected a trigger");
    const p = githubTurnPrompt(d.trigger, "/x/bin/github-app-comment.sh");
    expect(p).toContain("acme/api");
    expect(p).toContain("#7 broken thing");
    expect(p).toContain("is a pull request: no");
    expect(p).toContain("@jarvis-at-acme why?");
    expect(p).toContain("/x/bin/github-app-comment.sh acme/api 7 <file>");
    expect(p).toMatch(/no attribution/i);
  });

  test("Slack markup and attribution lines never reach GitHub", () => {
    const out = toGithubComment(
      "hi <@U123> see <https://x.dev/a|the doc> and <https://y.dev> in <#C1|eng>\nCo-Authored-By: Bot <b@x>\n🤖 Generated with [Claude Code](https://claude.com)",
    );
    expect(out).toBe("hi someone see [the doc](https://x.dev/a) and https://y.dev in #eng");
  });

  test("an unknown caller is told how to link", () => {
    expect(unknownSenderComment("dev-gh", "X/jv")).toContain("`X/jv review-inbox link dev-gh`");
  });
});

describe("a review asked of the app, and what else happens on a PR", () => {
  const opts = { slug: "jarvis-at-acme", label: "jarvis" };
  const repoPart = { repository: { full_name: "acme/api", owner: { login: "acme" } }, installation: { id: 42 } };
  const pr = { number: 7, title: "add thing", html_url: "https://github.com/acme/api/pull/7" };

  test("a review requested from the app's bot is a call, from anyone else it is not", () => {
    const requested = (login: string) => ({
      action: "review_requested",
      ...repoPart,
      sender: { login: "dev-gh", type: "User" },
      pull_request: pr,
      requested_reviewer: { login },
    });
    const d = detectTrigger("pull_request", "d1", requested("jarvis-at-acme[bot]"), opts);
    expect(d.kind).toBe("trigger");
    if (d.kind === "trigger") expect(d.trigger).toMatchObject({ via: "review-request", isPr: true, number: 7, sender: "dev-gh", url: pr.html_url });
    expect(detectTrigger("pull_request", "d2", requested("someone-else"), opts).kind).toBe("ignore");
    // a team request names no reviewer
    expect(detectTrigger("pull_request", "d3", { ...requested(""), requested_reviewer: undefined, requested_team: { slug: "t" } }, opts).kind).toBe("ignore");
    // the app requesting a review of itself is never a call
    expect(
      detectTrigger("pull_request", "d4", { ...requested("jarvis-at-acme[bot]"), sender: { login: "jarvis-at-acme[bot]", type: "Bot" } }, opts).kind,
    ).toBe("ignore");
  });

  test("comments and reviews of other people on a PR are activity, bots and plain issues are not", () => {
    const a = detectActivity("issue_comment", "d1", { action: "created", ...repoPart, sender: { login: "dev-gh", type: "User" }, issue: { ...pr, pull_request: {} }, comment: { id: 1, body: "hmm", html_url: "https://c" } }, opts);
    expect(a.kind).toBe("trigger");
    if (a.kind === "trigger") expect(a.trigger).toMatchObject({ via: "activity", activity: "comment", body: "hmm", commentUrl: "https://c", sender: "dev-gh" });
    expect(detectActivity("issue_comment", "d2", { action: "created", ...repoPart, sender: { login: "dev-gh", type: "User" }, issue: pr, comment: { body: "x" } }, opts).kind).toBe("ignore");
    expect(detectActivity("issue_comment", "d3", { action: "created", ...repoPart, sender: { login: "ci[bot]", type: "Bot" }, issue: { ...pr, pull_request: {} }, comment: { body: "x" } }, opts).kind).toBe("ignore");
    const inline = detectActivity("pull_request_review_comment", "d4", { action: "created", ...repoPart, sender: { login: "dev-gh", type: "User" }, pull_request: pr, comment: { body: "nit" } }, opts);
    expect(inline.kind === "trigger" && inline.trigger.activity).toBe("comment");
  });

  test("a submitted review is approved, changes or reviewed; an empty comment-only one and a dismissal are not news", () => {
    const review = (state: string, body = "text") => ({ action: "submitted", ...repoPart, sender: { login: "dev-gh", type: "User" }, pull_request: pr, review: { state, body } });
    const kinds = (state: string, body?: string) => {
      const d = detectActivity("pull_request_review", "d", review(state, body), opts);
      return d.kind === "trigger" ? d.trigger.activity : d.kind;
    };
    expect(kinds("approved", "")).toBe("approved");
    expect(kinds("changes_requested")).toBe("changes");
    expect(kinds("commented")).toBe("reviewed");
    expect(kinds("commented", "  ")).toBe("ignore");
    expect(kinds("dismissed")).toBe("ignore");
  });
});
