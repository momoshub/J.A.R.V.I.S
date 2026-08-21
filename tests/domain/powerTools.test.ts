import { describe, expect, test } from "bun:test";
import { parseMessageLink } from "../../src/domain/slackLinks.ts";
import { BOMB_SIZE, EMOJI_CATEGORIES, EMOJI_CATEGORY_NAMES, pickBomb } from "../../src/domain/emoji.ts";
import { REQUEST_CHANGES_BODY, reviewPrompt } from "../../src/domain/reviewPrompt.ts";

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
    const { emojis, used, unknown } = pickBomb(["positive"], 5);
    expect(emojis).toHaveLength(5);
    expect(new Set(emojis).size).toBe(5);
    expect(used).toEqual(["positive"]);
    expect(unknown).toEqual([]);
  });

  test("a bare category name still works", () => {
    expect(pickBomb("party", 3).emojis).toHaveLength(3);
  });

  test("categories combine into one pool, de-duplicated", () => {
    const { emojis, used } = pickBomb(["money", "face", "negative"], BOMB_SIZE);
    expect(used).toEqual(["money", "face", "negative"]);
    expect(emojis).toHaveLength(BOMB_SIZE);
    expect(new Set(emojis).size).toBe(BOMB_SIZE); // no emoji twice, even across categories
  });

  test("unknown names are reported, the known ones still fire", () => {
    const { emojis, used, unknown } = pickBomb(["face", "nope"], 4);
    expect(emojis).toHaveLength(4);
    expect(used).toEqual(["face"]);
    expect(unknown).toEqual(["nope"]);
  });

  test("nothing at all for an entirely unknown category", () => {
    expect(pickBomb(["nope"], 5).emojis).toEqual([]);
  });

  test("every category can supply a full burst on its own, or says why not", () => {
    for (const name of EMOJI_CATEGORY_NAMES) {
      const pool = EMOJI_CATEGORIES[name] ?? [];
      // drink and money are naturally small; the rest must carry a full bomb
      const expected = Math.min(BOMB_SIZE, pool.length);
      expect(pickBomb([name], BOMB_SIZE).emojis).toHaveLength(expected);
      if (!["drink", "money"].includes(name)) expect(pool.length).toBeGreaterThanOrEqual(BOMB_SIZE);
    }
  });

  test("no category repeats an emoji, which Slack would reject as already_reacted", () => {
    for (const name of EMOJI_CATEGORY_NAMES) {
      const pool = EMOJI_CATEGORIES[name] ?? [];
      expect(new Set(pool).size).toBe(pool.length);
    }
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

  test("house style: no dashes, no trailing full stop, lowercase sentence starts", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("no em dashes and no en dashes anywhere in the text");
    expect(p).toContain("do not put a full stop at the end of a paragraph");
    expect(p).toContain("do not capitalise the first word of a sentence");
    expect(p).toMatch(/unless the word is "I"/);
    expect(p).toContain("lowercase start, no trailing full stop"); // list items too
  });

  test("the prompt does not itself use the punctuation it bans", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie", { login: "kai", name: "Kai" });
    expect(p).not.toInclude("—"); // em dash
    expect(p).not.toInclude("–"); // en dash
  });

  test("mentions use GitHub tagging, never Slack tags", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("use GitHub tagging syntax - @login");
    expect(p).toMatch(/never a Slack <@ID> tag/);
    expect(p).toContain("do not tag your own account");
  });

  test("the word cap is scoped to normal PRs and never squeezes blockers", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("under 250 words for a normal PR");
    expect(p).toContain("A BIG PR (step 2) may run longer");
    expect(p).toContain("On flow B the cap never squeezes the blockers");
  });

  test("the approve is the caller's job, not the model's", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("ALREADY DONE, before you started");
    expect(p).toContain("Take the approval as a given");
  });

  test("exactly one of two flows, and only the risky one requests changes", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("EXACTLY ONE of the two flows");
    expect(p).toContain("Never both, never a mix");
    expect(p).toContain("exactly one gh pr comment per PR, it is the only place the review is written");
  });

  test("on the risky flow the change request is a static marker, then the comment", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    const requestChanges = p.indexOf(`--request-changes --body "${REQUEST_CHANGES_BODY}"`);
    const commentAfter = p.indexOf("then the review comment, which carries everything");
    expect(requestChanges).toBeGreaterThan(-1);
    expect(commentAfter).toBeGreaterThan(requestChanges); // order is load-bearing
    expect(p).toContain("The change request is a state flip, not a place to write");
    expect(p).toContain("never state a blocker in (a) and again in (b)");
    expect(p).toContain("lead with what is blocking and why");
  });

  test("the comment body must be written in the same command that posts it, so it can be relayed", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("Write the comment body in the SAME shell command");
    expect(p).toContain("Never write a body in one command and post it in another");
  });

  test("the Slack close-out is a wrap-up, since the bodies are relayed already", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("relayed into the thread as it lands");
    expect(p).toContain("do not paste it again");
    expect(p).toContain("just a cozy little glance from me and my claude");
  });
});
