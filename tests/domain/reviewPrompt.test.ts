import { describe, expect, test } from "bun:test";
import {
  asAgentCap,
  DEFAULT_REVIEW_AGENTS,
  isExtendedOwnerPr,
  REVIEW_AGENT_CEILING,
  reviewHelp,
  reviewPrompt,
} from "../../src/domain/reviewPrompt.ts";

const PR = "https://github.com/o/r/pull/1";

describe("asAgentCap", () => {
  test("accepts a sane count", () => {
    expect(asAgentCap("1")).toBe(1);
    expect(asAgentCap(" 5 ")).toBe(5);
    expect(asAgentCap(String(REVIEW_AGENT_CEILING))).toBe(REVIEW_AGENT_CEILING);
  });

  test("refuses anything that is not one, so the caller falls back", () => {
    expect(asAgentCap(undefined)).toBeUndefined();
    expect(asAgentCap("")).toBeUndefined();
    expect(asAgentCap("0")).toBeUndefined();
    expect(asAgentCap("-2")).toBeUndefined();
    expect(asAgentCap("2.5")).toBeUndefined();
    expect(asAgentCap("lots")).toBeUndefined();
    // nobody configures their way back to an unbounded fan-out
    expect(asAgentCap(String(REVIEW_AGENT_CEILING + 1))).toBeUndefined();
  });
});

describe("reviewPrompt fan-out", () => {
  test("caps child agents at the default and spawns them in one batch", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(DEFAULT_REVIEW_AGENTS).toBe(3);
    expect(p).toContain(`at most ${DEFAULT_REVIEW_AGENTS} child agents`);
    expect(p).toContain("in ONE batch");
    expect(p).toContain("Never a second round");
  });

  test("a configured cap replaces it", () => {
    expect(reviewPrompt([PR], "Bot", undefined, [PR], 5)).toContain("at most 5 child agents");
  });

  test("a cap of one does not tell the brain to avoid one agent at a time", () => {
    // the plural wording contradicts itself at 1: "at most 1 agent, in one
    // parallel batch, never one agent at a time"
    const p = reviewPrompt([PR], "Bot", undefined, [PR], 1);
    expect(p).toContain("exactly ONE child agent");
    expect(p).not.toContain("one agent at a time");
    expect(p).not.toContain("in parallel. Never a second round");
  });

  test("an unfinished agent never holds the review hostage", () => {
    // the failure this exists for: a run that waits out its whole budget on one
    // agent and times out having posted nothing
    expect(reviewPrompt([PR], "Bot")).toContain("drop it and post the review with what you have");
  });

  test("a late agent's blocking finding is posted, never raised as a question", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("LATE FINDING");
    expect(p).toContain("post ONE short follow-up comment");
    expect(p).toContain("Never hold a verified blocker back");
  });

  test("it decides instead of asking - nobody is there to answer", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("Decide, never ask");
    expect(p).toContain('Never end on "say the word"');
    expect(p).toContain("or close on a question");
  });

  test("no running commentary - the thread gets progress lines already", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("Work quietly");
    expect(p).toContain('no "waiting on the agents"');
  });

  test("the asker's note aims the review without loosening it", () => {
    const p = reviewPrompt([PR], "Bot", undefined, [PR], 3, "the migration is the risky bit");
    expect(p).toContain("the migration is the risky bit");
    expect(p).toContain("What the person asking wants you to look at");
    // it steers, it does not govern
    expect(p).toContain("It does not change anything else in this brief");
    expect(p).toContain("never a reason to skip a PR");
  });

  test("no note means no section at all", () => {
    for (const empty of [undefined, "", "   "]) {
      expect(reviewPrompt([PR], "Bot", undefined, [PR], 3, empty)).not.toContain("in their words");
    }
  });

  test("a note asking for something outside a PR review is refused, out loud", () => {
    const p = reviewPrompt([PR], "Bot", undefined, [PR], 3, "also merge it and deploy");
    expect(p).toContain("ignore that part and say so");
  });
});

describe("reviewPrompt comment shape", () => {
  test("blockers only: a verdict line, then one bullet per blocker, worst first", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain('line 1: where you land, "good to merge" or what blocks');
    expect(p).toContain('one "- " bullet per blocker, worst first');
  });

  test("a clean PR gets one line", () => {
    expect(reviewPrompt([PR], "Bot")).toContain("A clean PR gets this line and the sign-off, nothing else");
  });

  test("non-blocking findings never reach the comment", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("NON-BLOCKING findings");
    expect(p).toContain("never go in the comment");
  });

  test("non-blocking findings never become an issue", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("never become an issue: they are dropped");
    expect(p).toContain("Never open an issue");
    expect(p).not.toContain("gh issue create");
  });

  test("a declared gap is not a blocker, but what the PR breaks is not excused", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("A gap the PR declares out of scope is never a blocker");
    expect(p).toContain("a problem the PR itself introduces is not out of scope");
  });

  test("known content is not said again, and it is read first", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("READ the description and every existing comment before you review");
    expect(p).toContain("no summary of the diff");
  });

  test("it points at the code rather than reproducing it", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("ONE pointer");
    expect(p).toContain("Never paste code");
  });

  test("failing CI blocks, and nothing unverified is raised", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("or failing CI");
    expect(p).toContain("never fabricate");
  });

  test("the prompt stays lean", () => {
    // the owner asked for a token-efficient prompt; it was ~12.6k chars before
    const p = reviewPrompt([PR], "Bot", { login: "kai", name: "Kai" });
    expect(p.length).toBeLessThan(7500);
  });
});

describe("reviewPrompt per-owner shape", () => {
  const OWNERS = ["acme-corp"];
  const EXT = "https://github.com/acme-corp/api/pull/7";
  const EXT_UPPER = "https://github.com/Acme-Corp/x/pull/2";
  const build = (urls: string[], reviewer?: { login: string; name: string }) =>
    reviewPrompt(urls, "Bot", reviewer, urls, undefined, undefined, OWNERS);

  test("isExtendedOwnerPr matches a configured owner only, case-insensitive", () => {
    expect(isExtendedOwnerPr(EXT, OWNERS)).toBe(true);
    expect(isExtendedOwnerPr(EXT_UPPER, OWNERS)).toBe(true);
    expect(isExtendedOwnerPr(EXT, ["ACME-CORP"])).toBe(true);
    expect(isExtendedOwnerPr(PR, OWNERS)).toBe(false);
    expect(isExtendedOwnerPr("https://github.com/o/acme-corp/pull/1", OWNERS)).toBe(false);
    expect(isExtendedOwnerPr("https://github.com/acme-corp-fork/r/pull/1", OWNERS)).toBe(false);
    expect(isExtendedOwnerPr("#12", OWNERS)).toBe(false);
    expect(isExtendedOwnerPr("12", OWNERS)).toBe(false);
  });

  test("no configured owners means no PR is extended", () => {
    expect(isExtendedOwnerPr(EXT, [])).toBe(false);
    expect(reviewPrompt([EXT], "Bot")).toContain("never go in the comment and never become an issue: they are dropped");
  });

  test("isExtendedOwnerPr reads the owner/repo#N shorthand too", () => {
    expect(isExtendedOwnerPr("acme-corp/api#7", OWNERS)).toBe(true);
    expect(isExtendedOwnerPr("Acme-Corp/x#2", OWNERS)).toBe(true);
    expect(isExtendedOwnerPr("o/acme-corp#7", OWNERS)).toBe(false);
    expect(isExtendedOwnerPr("acme-corp/x", OWNERS)).toBe(false);
  });

  test("a configured owner's PR posts non-blocking bullets and the out-of-scope bullet", () => {
    const p = build([EXT]);
    expect(p).toContain("NON-BLOCKING findings (design risk, correctness, coding style, real cleanups) go in the comment");
    expect(p).toContain("blockers, then non-blocking findings, then the out-of-scope bullet last");
    expect(p).toContain("out of scope per the description: ... risk left standing");
    expect(p).toContain("under 250 words");
    expect(p).toContain("blockers are never squeezed");
    expect(p).toContain("never make flow B and never become an issue");
    expect(p).toContain("Never open an issue");
    expect(build([EXT_UPPER])).toContain("go in the comment");
  });

  test("any other owner keeps the blockers-only text", () => {
    const p = build([PR]);
    expect(p).toContain("never go in the comment and never become an issue: they are dropped");
    expect(p).toContain('one "- " bullet per blocker, worst first');
    expect(p).not.toContain("out of scope per the description");
    expect(p).not.toContain("under 250 words");
    expect(p).not.toContain("Extended-review PRs");
  });

  test("a mixed batch says which PR gets which shape", () => {
    const p = build([EXT, PR]);
    expect(p).toContain(`Extended-review PRs (non-blocking findings are posted):\n${EXT}`);
    expect(p).toContain(`Every other PR (blockers only, non-blocking findings are never posted):\n${PR}`);
    expect(p).toContain("For every other PR: non-blocking findings never go in the comment");
    expect(p).toContain("out of scope per the description");
  });

  test("the extended prompt stays lean too", () => {
    expect(build([EXT, PR], { login: "kai", name: "Kai" }).length).toBeLessThan(9000);
  });
});

describe("reviewHelp", () => {
  test("names the configured owners as getting non-blocking findings", () => {
    const h = reviewHelp("X", false, 3, "Bot", undefined, ["acme-corp", "other-org"]);
    expect(h).toContain("`acme-corp` or `other-org`");
    expect(h).toContain("out of scope per the description");
  });

  test("with no owners configured it says non-blocking findings are never posted", () => {
    const h = reviewHelp("X", false, 3, "Bot");
    expect(h).not.toContain("out of scope per the description");
    expect(h).toContain("non-blocking findings are never posted, and never become an issue");
  });
});
