import { describe, expect, test } from "bun:test";
import { toMrkdwn, toSlackMarkdown } from "../../src/domain/slackFormat.ts";
import { toBlockMessage, normalizeBlocks } from "../../src/domain/blockKit.ts";
import { collapsedBlocks } from "../../src/domain/collapseSteps.ts";

describe("toSlackMarkdown", () => {
  const cases: [string, string, string][] = [
    ["bold", "*nhịp:* ok", "**nhịp:** ok"],
    ["strike", "a ~gone~ b", "a ~~gone~~ b"],
    ["already bold", "**x** and ~~y~~", "**x** and ~~y~~"],
    ["bullet", "* item\n* other", "* item\n* other"],
    ["arithmetic", "a * b and 2*3*4", "a * b and 2*3*4"],
    ["approx", "~5 min and ~10 min", "~5 min and ~10 min"],
    ["unpaired", "a *b", "a *b"],
    ["italic untouched", "_x_ and *y*", "_x_ and **y**"],
    ["nested", "*a _b_ c*", "**a _b_ c**"],
    ["inline code", "`*x*` and *y*", "`*x*` and **y**"],
    ["fence", "```\n*x*\n```\n*y*", "```\n*x*\n```\n**y**"],
    ["slack link", "<https://a.com/*x*|*l*>", "<https://a.com/*x*|*l*>"],
    ["escaped", "\\*x*", "\\*x*"],
  ];
  for (const [name, input, want] of cases) test(name, () => expect(toSlackMarkdown(input)).toBe(want));
  test("idempotent", () => {
    const once = toSlackMarkdown("*a* ~b~ **c**");
    expect(toSlackMarkdown(once)).toBe(once);
  });
});

describe("markdown blocks carry bold, text fallbacks stay mrkdwn", () => {
  test("toBlockMessage", () => {
    const fence = '```blockkit\n[{"type":"divider"}]\n```';
    const msg = toBlockMessage(`*hi* there\n${fence}`, toMrkdwn);
    expect(msg?.blocks[0]).toEqual({ type: "markdown", text: "**hi** there" });
    expect(msg?.text).toBe("*hi* there");
  });
  test("collapsedBlocks body", () => {
    expect(collapsedBlocks(toMrkdwn("**a** and *b*"), undefined)[0]).toEqual({ type: "markdown", text: "**a** and **b**" });
  });
  test("a model-written markdown block", () => {
    expect(normalizeBlocks([{ type: "markdown", text: "*x*" }])).toEqual([{ type: "markdown", text: "**x**" }]);
  });
});
