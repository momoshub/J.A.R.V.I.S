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
    expect(p).toContain("Do NOT run `gh pr review --approve` yourself"); // the caller already did
    expect(p).toContain("--request-changes"); // reverse on high risk
    expect(p).toContain("Task tool"); // child agents for big PRs
    expect(p).toContain("just a cozy little glance from me and my claude");
  });

  test("never skips a merged or closed PR - it is reviewed like any other", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("NEVER skip a PR");
    expect(p).toMatch(/Merged and closed PRs get the exact same treatment as open ones/);
    // the old behavior - bail out on a merged PR - must be gone
    expect(p).not.toMatch(/skip a pr that is already merged/i);
  });

  test("writes as the gh account and disowns the standing approval", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie", { login: "kai-at-acme", name: "Kai" });
    expect(p).toContain("Write it as Kai, an engineer");
    expect(p).toContain("(kai-at-acme)");
    expect(p).toContain("never mention it");
    expect(p).toContain("Approvals and change requests from OTHER reviewers DO count");
  });

  test("falls back to the bot's own name when the account is unknown", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("Write it as Evie, an engineer");
    expect(p).toContain("from your own account -");
  });

  test("mentions use GitHub tagging, never Slack tags", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("use GitHub tagging syntax - @login");
    expect(p).toMatch(/never a Slack <@ID> tag/);
    expect(p).toContain("do not tag your own account");
  });

  test("the word cap is scoped to normal PRs and never to the blocker list", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("under 250 words for a normal PR");
    expect(p).toContain("A BIG PR (step 2) may run longer");
    expect(p).toContain("The cap never applies to the required-changes list");
  });

  test("the approve is the caller's job, not the model's", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("ALREADY DONE, before you started");
    expect(p).toContain("Take the approval as a given");
  });

  test("splits a high-risk review: full review as a comment, blockers only in request-changes", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("split the review in two and post BOTH");
    expect(p).toMatch(/request-changes body is the blocker list and nothing else/);
    expect(p).toContain("only what MUST be fixed before merge");
  });

  test("bodies must be written in the same command that posts them, so they can be relayed", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("Write each body in the SAME shell command");
    expect(p).toContain("Never write a body in one command and post it in another");
  });

  test("the Slack close-out is a wrap-up, since the bodies are relayed already", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("relayed into the thread as it lands");
    expect(p).toContain("do not paste it again");
    expect(p).toContain("just a cozy little glance from me and my claude");
  });
});
