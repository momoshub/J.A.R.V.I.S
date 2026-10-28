import { describe, expect, test } from "bun:test";
import { notePrompt } from "../../src/domain/notePrompt.ts";
import { credentialGapRules } from "../../src/domain/credentialGap.ts";

const req = {
  path: "/tmp/runbook.md",
  parent: "https://notion.so/parent-page",
  askedBy: "U1",
};

describe("notePrompt", () => {
  test("it names the file, the parent and who asked", () => {
    const p = notePrompt(req, "Bot");
    expect(p).toContain("/tmp/runbook.md");
    expect(p).toContain("https://notion.so/parent-page");
    expect(p).toContain("<@U1>");
  });

  test("it takes the title from the document when none is given", () => {
    expect(notePrompt(req, "Bot")).toContain("first heading");
    expect(notePrompt({ ...req, title: "CPV2 runbook" }, "Bot")).toContain("Title: CPV2 runbook");
  });

  test("it publishes what it was handed, rather than improving it", () => {
    const p = notePrompt(req, "Bot");
    expect(p).toContain("do not summarise");
    expect(p).toContain("publishing what you were handed");
  });

  test("it creates exactly one page and edits nothing that exists", () => {
    const p = notePrompt(req, "Bot");
    expect(p).toContain("do not create more than one page");
    expect(p).toContain("do not edit, move or delete any page that already exists");
  });

  test("an unreachable parent stops the job rather than guessing another", () => {
    // writing a team's runbook into the wrong place is worse than not writing it
    const p = notePrompt(req, "Bot");
    expect(p).toContain("Do not pick a different parent");
  });

  test("it reports the url, not a summary of the document", () => {
    expect(notePrompt(req, "Bot")).toContain("They wrote it");
  });
});

describe("the connector-write rule", () => {
  test("only Slack POSTING is described as denied", () => {
    // the blanket version turned a missing command into a flat refusal: the bot
    // wrote a runbook, then told someone to paste it into Notion themselves
    const rules = credentialGapRules("X/jv");
    expect(rules).not.toContain("may never WRITE");
    expect(rules).toContain("POSTING through the Slack connector");
  });

  test("and the Notion route is spelled out", () => {
    const rules = credentialGapRules("X/jv");
    expect(rules).toContain("X/jv note");
    expect(rules).toContain('"I cannot write to Notion" is simply wrong');
  });
});
