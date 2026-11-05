import { describe, expect, test } from "bun:test";
import { asReviewPolicy, authorRefOf, DEFAULT_REVIEW_POLICY, stricterPolicy, looksLikePrRef, parsePolicyArg, repoOf, repoRefOf } from "../../src/domain/reviewPolicy.ts";

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

  test("prose that merely looks like the flag is left where it was typed", () => {
    // "check the policy:handler code" used to refuse the whole command with
    // "`handler` is not a policy", which is a review that never ran
    const { asked, bad, rest } = parsePolicyArg([PR, "check", "the", "policy:handler", "code"]);
    expect(asked).toBeUndefined();
    expect(bad).toBeUndefined();
    expect(rest).toEqual([PR, "check", "the", "policy:handler", "code"]);

    // and the bare words are ordinary English, not instructions
    expect(parsePolicyArg([PR, "the", "RLS", "policy", "after", "the", "migration"]).asked).toBeUndefined();
    expect(parsePolicyArg([PR, "approve", "after", "CI", "is", "green"]).asked).toBeUndefined();
  });

  test("the flag applies to every PR in the run, wherever it was typed", () => {
    const other = "https://github.com/o/r2/pull/2";
    const { asked, rest } = parsePolicyArg([PR, "--policy", "after", other, "focus", "on", "the", "migration"]);
    expect(asked).toBe("approve-after");
    expect(rest).toEqual([PR, other, "focus", "on", "the", "migration"]);
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

describe("looksLikePrRef", () => {
  test("accepts what people actually type for a PR", () => {
    expect(looksLikePrRef("https://github.com/o/r/pull/1")).toBe(true);
    expect(looksLikePrRef("<https://github.com/o/r/pull/1>")).toBe(true);
    expect(looksLikePrRef("acme/acme-be#13600")).toBe(true);
    expect(looksLikePrRef("o/r/pull/7")).toBe(true);
    expect(looksLikePrRef("#2149")).toBe(true);
    expect(looksLikePrRef("2149")).toBe(true);
  });

  test("refuses a stray word, which used to cost a whole review", () => {
    // `review help` spawned a full review of a PR named "help", on the asker's
    // own credential, to answer a question about how reviewing works
    expect(looksLikePrRef("help")).toBe(false);
    expect(looksLikePrRef("the")).toBe(false);
    expect(looksLikePrRef("acme-be")).toBe(false);
    expect(looksLikePrRef("")).toBe(false);
  });
});

describe("authorRefOf", () => {
  test("gh, API and typed spellings of one login agree", () => {
    for (const t of ["app/morcela-agent", "morcela-agent[bot]", "@Morcela-Agent", "morcela-agent"]) {
      expect(authorRefOf(t)).toBe("morcela-agent");
    }
  });

  test("junk is not a login", () => {
    for (const junk of ["", "a b", "-x", "o/r/c"]) expect(authorRefOf(junk)).toBeUndefined();
  });
});

describe("stricterPolicy", () => {
  test("either side asking for a review first wins", () => {
    expect(stricterPolicy("approve-first", "approve-after")).toBe("approve-after");
    expect(stricterPolicy("approve-after", "approve-first")).toBe("approve-after");
    expect(stricterPolicy("approve-first", undefined)).toBe("approve-first");
  });
});
