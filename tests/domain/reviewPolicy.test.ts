import { describe, expect, test } from "bun:test";
import { asReviewPolicy, DEFAULT_REVIEW_POLICY, repoOf, repoRefOf } from "../../src/domain/reviewPolicy.ts";

describe("repoOf", () => {
  test("reads owner/repo out of a PR url", () => {
    expect(repoOf("https://github.com/acme/sql-runner/pull/905")).toBe(
      "acme/sql-runner",
    );
    expect(repoOf("https://github.com/acme/sql-runner/pull/905/files")).toBe(
      "acme/sql-runner",
    );
    expect(repoOf("HTTPS://GitHub.com/acme/sql-runner/pull/1")).toBe("acme/sql-runner");
  });

  test("undefined for anything that is not a PR url", () => {
    expect(repoOf("https://github.com/acme/sql-runner")).toBeUndefined();
    expect(repoOf("hello")).toBeUndefined();
  });
});

describe("repoRefOf", () => {
  test("takes the shorthand people actually type", () => {
    expect(repoRefOf("acme/sql-runner")).toBe("acme/sql-runner");
    expect(repoRefOf("https://github.com/acme/sql-runner")).toBe("acme/sql-runner");
    expect(repoRefOf("<https://github.com/acme/sql-runner/>")).toBe("acme/sql-runner");
    expect(repoRefOf("https://github.com/acme/sql-runner/pull/905")).toBe(
      "acme/sql-runner",
    );
  });

  test("refuses something that is not a repo", () => {
    for (const junk of ["", "acme", "a/b/c", "not a repo"]) expect(repoRefOf(junk)).toBeUndefined();
  });
});

describe("asReviewPolicy", () => {
  test("only the two known policies survive a round trip", () => {
    expect(asReviewPolicy("approve-after")).toBe("approve-after");
    expect(asReviewPolicy("approve-first")).toBe("approve-first");
  });

  test("anything else is not a policy, so the default applies", () => {
    for (const junk of [undefined, "", "yes", "APPROVE-AFTER"]) expect(asReviewPolicy(junk)).toBeUndefined();
    expect(DEFAULT_REVIEW_POLICY).toBe("approve-first");
  });
});
