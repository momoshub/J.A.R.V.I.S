import { describe, expect, test } from "bun:test";
import {
  activityText,
  alreadyReviewedText,
  askText,
  asksForReview,
  bareLogin,
  parsePrUrl,
  prKeyOf,
  requestedText,
  reviewNoteOf,
  sameLogin,
} from "../../src/domain/reviewIdentity.ts";

describe("PR keys and logins", () => {
  test("one key per PR whatever the casing", () => {
    expect(prKeyOf("Acme/Repo", 7)).toBe("acme/repo#7");
    expect(parsePrUrl("https://github.com/Acme/Repo/pull/7")).toEqual({ repo: "Acme/Repo", number: 7 });
    expect(parsePrUrl("https://github.com/acme/repo/issues/7")).toBeUndefined();
  });

  test("a bot is the same account however GitHub spells it", () => {
    expect(bareLogin("app/jv-app")).toBe("jv-app");
    expect(sameLogin("jv-app[bot]", "app/jv-app")).toBe(true);
    expect(sameLogin("JV-App", "jv-app[bot]")).toBe(true);
    expect(sameLogin("kai", "jv-app")).toBe(false);
    expect(sameLogin("", "")).toBe(false);
  });
});

describe("a mention that asks for a review", () => {
  test("review, re-review and approve count; anything else stays a general call", () => {
    expect(asksForReview("@jv-app please review this", "jv-app")).toBe(true);
    expect(asksForReview("@jv-app re-review", "jv-app")).toBe(true);
    expect(asksForReview("@jv-app approve if it is fine", "jv-app")).toBe(true);
    expect(asksForReview("@jv-app what does this do?", "jv-app")).toBe(false);
    expect(asksForReview("@jv-app summarise the PR", "jv-app")).toBe(false);
  });

  test("the app's own name never counts, even when it holds the word", () => {
    expect(asksForReview("@review-bot what does this do?", "review-bot")).toBe(false);
    expect(asksForReview("@review-bot[bot] hi", "review-bot")).toBe(false);
    expect(asksForReview("@review-bot please review", "review-bot")).toBe(true);
  });

  test("the note is what was said next to the mention, bounded", () => {
    expect(reviewNoteOf("@jv-app review the migration  is risky", "jv-app")).toBe("review the migration is risky");
    expect(reviewNoteOf(`@jv-app ${"x".repeat(900)}`, "jv-app", 100)).toHaveLength(100);
  });
});

describe("what the thread says", () => {
  const base = { url: "https://github.com/o/r/pull/7", repo: "o/r", number: 7, title: "add thing", headSha: "abcdef1234567" };

  test("a request to the app and one to the human account read differently", () => {
    const app = requestedText({ ...base, asker: { login: "dev", slackId: "U1" }, identity: "app", account: "jv-app[bot]" });
    expect(app).toContain("<@U1> asked the app (`jv-app[bot]`) to review <https://github.com/o/r/pull/7|o/r#7>");
    expect(app).toContain("`abcdef1`");
    const human = requestedText({ ...base, asker: { login: "dev" }, identity: "human", account: "kai-gh" });
    expect(human).toContain("`dev` asked `kai-gh` to review");
  });

  test("the owner's question names who asked, why, and what each button does", () => {
    const line = { ...base, ownerSlackId: "UOWNER", identity: "app" as const };
    const noToken = askText({ ...line, asker: { login: "dev", slackId: "U1" }, reason: "no-token" });
    expect(noToken).toContain("<@U1>");
    expect(noToken).toContain("no Claude Code token on file");
    expect(noToken).toContain("<@UOWNER>");
    expect(noToken).toContain("the approval (if it is clean) as the GitHub account");
    const unknown = askText({ ...line, asker: { login: "stranger" }, reason: "unknown" });
    expect(unknown).toContain("`stranger`");
    expect(unknown).toContain("cannot tell who that is on Slack");
  });

  test("activity lines name the author, quote the text and say what happened", () => {
    expect(activityText({ kind: "approved", login: "dev", url: base.url, body: "" })).toBe("✅ `dev` approved (a review)");
    expect(activityText({ kind: "changes", login: "dev", url: base.url, body: "fix it", link: "https://x/y" })).toBe(
      "🚫 `dev` requested changes (<https://x/y|review>)\n> fix it",
    );
    expect(activityText({ kind: "comment", login: "dev", url: base.url, body: "a\nb" })).toBe("💬 `dev` commented (a comment)\n> a\n> b");
  });

  test("a repeat request on a reviewed head says how to get another", () => {
    expect(alreadyReviewedText("abcdef1234")).toContain("`abcdef1`");
  });
});
