import { describe, expect, test } from "bun:test";
import { asReviewPolicy, DEFAULT_REVIEW_POLICY, parsePolicyArg, repoOf, repoRefOf } from "../../src/domain/reviewPolicy.ts";

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

describe("parsePolicyArg", () => {
  const PR = "https://github.com/o/r/pull/1";

  test("every spelling people reach for", () => {
    expect(parsePolicyArg([PR, "--policy", "after"]).asked).toBe("approve-after");
    expect(parsePolicyArg([PR, "--policy=first"]).asked).toBe("approve-first");
    expect(parsePolicyArg([PR, "policy:after"]).asked).toBe("approve-after");
    expect(parsePolicyArg([PR, "--policy", "approve-first"]).asked).toBe("approve-first");
    expect(parsePolicyArg([PR, "--after"]).asked).toBe("approve-after");
    expect(parsePolicyArg([PR, "--first"]).asked).toBe("approve-first");
    expect(parsePolicyArg([PR, "--policy", "default"]).asked).toBe("default");
  });

  test("the flag is taken out of the way, in order", () => {
    // it must reach neither the url parser nor the note that steers the review
    const { rest } = parsePolicyArg(["--policy", "after", PR, "the", "migration"]);
    expect(rest).toEqual([PR, "the", "migration"]);
    expect(parsePolicyArg([PR, "--first", "check", "perf"]).rest).toEqual([PR, "check", "perf"]);
  });

  test("a value that is not a policy is reported, not silently ignored", () => {
    // the failure mode to avoid: "--policy sometimes" quietly reviewing on the
    // repo's own policy while the asker believes they changed it
    expect(parsePolicyArg([PR, "--policy", "sometimes"]).bad).toBe("sometimes");
    expect(parsePolicyArg([PR, "--policy=maybe"]).bad).toBe("maybe");
    expect(parsePolicyArg([PR, "--policy"]).bad).toBe("");
  });

  test("no flag, nothing taken and nothing asked", () => {
    const out = parsePolicyArg([PR, "focus on the sql"]);
    expect(out.asked).toBeUndefined();
    expect(out.bad).toBeUndefined();
    expect(out.rest).toEqual([PR, "focus on the sql"]);
  });
});
