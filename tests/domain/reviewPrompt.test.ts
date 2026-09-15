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

  test("a configured cap replaces it, and reads naturally at one", () => {
    expect(reviewPrompt([PR], "Bot", undefined, [PR], 5)).toContain("at most 5 child agents");
    expect(reviewPrompt([PR], "Bot", undefined, [PR], 1)).toContain("at most 1 child agent");
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
});
