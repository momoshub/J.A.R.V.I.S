import { describe, expect, test } from "bun:test";
import {
  asAgentCap,
  DEFAULT_REVIEW_AGENTS,
  REVIEW_AGENT_CEILING,
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
    expect(p).toContain("never close on a question");
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
    expect(p).toContain("never be a reason to skip a PR");
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

  test("findings come as bullets, one issue each, worst first", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("the findings as a bullet list, one bullet per issue");
    expect(p).toContain("No bullet that is really two issues");
    expect(p).toContain("Order them worst first");
  });

  test("known content is not worth saying twice", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("SAY NOTHING THAT IS ALREADY SAID");
    expect(p).toContain("never summarise the diff");
    // and it must read them first, or it cannot know what is already said
    expect(p).toContain("READ the description and every existing comment before you review");
  });

  test("a declared gap is warned about, not reviewed as a finding", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("DECLARED OUT OF SCOPE");
    expect(p).toContain("what risk is left standing");
    expect(p).toContain("Never count it as blocking");
    // but scope covers what a PR does not fix, never what it breaks
    expect(p).toContain("does NOT excuse what the PR itself breaks");
  });

  test("it points at the code rather than reproducing it", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("Point at the code, do not reproduce it");
    expect(p).toContain("Never paste a code block");
    expect(p).toContain("ONE short pointer per bullet");
  });
});
