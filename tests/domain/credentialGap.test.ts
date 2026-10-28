import { describe, expect, test } from "bun:test";
import { credentialGapRules, HOST_COMMANDS } from "../../src/domain/credentialGap.ts";

describe("credentialGapRules", () => {
  const r = credentialGapRules("X/jv");

  test("it names every shape the same failure arrives in", () => {
    // Datadog said "the connector isn't loaded", Slack said channel_not_found,
    // Notion said "it is private" - one problem, three costumes
    expect(r).toContain("channel_not_found");
    expect(r).toContain("it is private");
    expect(r).toContain("403");
    expect(r).toContain("not being in your tool list");
    expect(r).toContain("the credential for this turn is the wrong one");
  });

  test("and gives one fix, with every route listed", () => {
    for (const c of HOST_COMMANDS) expect(r).toContain(`X/jv ${c.name}`);
    expect(r).toContain("run it YOURSELF");
  });

  test("it forbids the two things it actually did instead", () => {
    // grepping ~/.claude.json for Datadog keys; curling notion.so unauthenticated
    expect(r).toContain("no grepping config files for API keys");
    expect(r).toContain("proves nothing");
    expect(r).toContain("a conclusion you did not earn");
  });

  test("the one real prohibition is Slack POSTING, and only that", () => {
    // the rule used to forbid every connector write. That is false - the tool
    // policy denies the Slack connector's posting tools and nothing else - and
    // it cost a real answer: the bot wrote a runbook, then told someone to
    // paste it into Notion themselves
    expect(r).toContain("POSTING through the Slack connector");
    expect(r).toContain("under the name of the human who authorised it");
    expect(r).not.toContain("You may never WRITE this way");
  });

  test("and writing elsewhere is routed, not refused", () => {
    expect(r).toContain("writing elsewhere is NOT forbidden");
    expect(r).toContain('"I cannot write to Notion" is simply wrong');
  });

  test("a genuine dead end is still a real answer", () => {
    expect(r).toContain("THAT is a real answer");
  });

  test("the routes are substituted with the instance's own prefix", () => {
    expect(credentialGapRules("//bot")).toContain("//bot read");
    expect(credentialGapRules("//bot")).not.toContain("X/jv");
  });
});
