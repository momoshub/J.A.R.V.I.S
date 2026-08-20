import { describe, expect, test } from "bun:test";
import { parseMessageLink } from "../../src/domain/slackLinks.ts";
import { EMOJI_CATEGORY_NAMES, pickBomb } from "../../src/domain/emoji.ts";
import { reviewPrompt } from "../../src/domain/reviewPrompt.ts";

describe("parseMessageLink", () => {
  test("parses channel + ts from a permalink", () => {
    expect(parseMessageLink("https://team.slack.com/archives/C0TEST00001/p1787122692303399")).toEqual({
      channel: "C0TEST00001",
      ts: "1787122692.303399",
    });
  });
  test("rejects a non-link", () => {
    expect(parseMessageLink("hello")).toBeUndefined();
    expect(parseMessageLink("https://team.slack.com/archives/C1")).toBeUndefined();
  });
});

describe("pickBomb", () => {
  test("returns distinct emoji from a known category, capped", () => {
    const out = pickBomb("positive", 5);
    expect(out).toHaveLength(5);
    expect(new Set(out).size).toBe(5);
  });
  test("empty for an unknown category", () => {
    expect(pickBomb("nope", 5)).toEqual([]);
  });
  test("categories are exposed", () => {
    expect(EMOJI_CATEGORY_NAMES).toContain("party");
    expect(EMOJI_CATEGORY_NAMES).toContain("heart");
  });
});

describe("reviewPrompt", () => {
  test("names the bot, embeds the PR urls, and encodes the approve-then-review flow", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("You are Evie");
    expect(p).toContain("https://github.com/o/r/pull/1");
    expect(p).toContain("gh pr review <url> --approve"); // approve first
    expect(p).toContain("--request-changes"); // reverse on high risk
    expect(p).toContain("Task tool"); // child agents for big PRs
    expect(p).toContain("just a cozy little glance from me and my claude");
  });

  test("never skips a merged or closed PR - it is approved and reviewed like any other", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("NEVER skip a PR");
    expect(p).toMatch(/regardless of whether the PR is open, merged or closed/);
    // the old behavior - bail out on a merged PR - must be gone
    expect(p).not.toMatch(/skip a pr that is already merged/i);
  });

  test("splits a high-risk review: full review as a comment, blockers only in request-changes", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("split the review in two and post BOTH");
    expect(p).toMatch(/request-changes body is the blocker list and nothing else/);
    expect(p).toContain("only what MUST be fixed before merge");
    expect(p).toContain("Required changes:"); // kept separate in Slack too
  });

  test("requires the review body in Slack too, verbatim, not a summary", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("verbatim");
    expect(p).toMatch(/never a summary of it/i);
  });
});
