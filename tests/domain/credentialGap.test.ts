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

  test("and keeps read/write asymmetry, which is the one real prohibition", () => {
    expect(r).toContain("You may never WRITE this way");
    expect(r).toContain("under the name of the human who authorised it");
  });

  test("a genuine dead end is still a real answer", () => {
    expect(r).toContain("THAT is a real answer");
  });

  test("the routes are substituted with the instance's own prefix", () => {
    expect(credentialGapRules("//bot")).toContain("//bot read");
    expect(credentialGapRules("//bot")).not.toContain("X/jv");
  });
});
