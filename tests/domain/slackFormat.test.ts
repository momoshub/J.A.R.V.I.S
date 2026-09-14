import { describe, expect, test } from "bun:test";
import { SLACK_BREVITY, SLACK_FORMAT } from "../../src/domain/slackFormat.ts";
import { buildSystemPrompt } from "../../src/domain/personality.ts";
import { ticketPrompt } from "../../src/domain/ticketPrompt.ts";
import { reviewPrompt } from "../../src/domain/reviewPrompt.ts";

describe("SLACK_FORMAT", () => {
  test("names the traps that actually bite - mrkdwn is not Markdown", () => {
    expect(SLACK_FORMAT).toContain("*one asterisk*, never **two**");
    expect(SLACK_FORMAT).toContain("<https://example.com|the label>, never [the label](https://example.com)");
    expect(SLACK_FORMAT).toContain("there are no headings");
    expect(SLACK_FORMAT).toContain("there are no tables");
  });

  test("a bare @name notifies nobody, so tags are spelled out", () => {
    expect(SLACK_FORMAT).toContain("<@U123>");
    expect(SLACK_FORMAT).toContain("A bare @name notifies nobody");
  });
});

describe("SLACK_BREVITY", () => {
  test("is about what the reader needs, not a character count", () => {
    expect(SLACK_BREVITY).toContain("one to three short lines");
    expect(SLACK_BREVITY).toContain("lead with the answer");
    expect(SLACK_BREVITY).toContain("never narrate what you are about to do");
  });
});

describe("every prompt that writes to Slack carries the rules", () => {
  test("ordinary chat", () => {
    const p = buildSystemPrompt({ botName: "Evie" });
    expect(p).toContain("mrkdwn, NOT Markdown");
    expect(p).toContain("one to three short lines");
  });

  test("the ticket report, with a fixed shape rather than prose", () => {
    const p = ticketPrompt("x", "Evie", { tracker: "t" });
    expect(p).toContain("mrkdwn, NOT Markdown");
    expect(p).toContain("Keep it to three lines");
    expect(p).toContain("🎫 <ticket url|TICKET-ID");
    expect(p).toContain("Never paste the ticket body");
  });

  test("the review close-out, without disturbing the GitHub house style", () => {
    const p = reviewPrompt(["https://github.com/o/r/pull/1"], "Evie");
    expect(p).toContain("Close out in Slack, which renders differently from GitHub");
    expect(p).toContain("mrkdwn, NOT Markdown");
    // the comment that goes to GitHub keeps its own rules
    expect(p).toContain("no em dashes and no en dashes anywhere in the text");
    expect(p).toContain("just a cozy little glance from me and my claude");
  });
});
