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
  test("names the bot, embeds the PR urls, and forbids writes", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("You are Evie");
    expect(p).toContain("https://github.com/o/r/pull/1");
    expect(p).toContain("read-only");
    expect(p).toContain("just a cozy little glance from em and my claude 🙈");
  });
});
