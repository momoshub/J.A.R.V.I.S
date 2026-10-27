import { describe, expect, test } from "bun:test";
import { slackReadRules } from "../../src/domain/slackRead.ts";

describe("slackReadRules", () => {
  test("it offers the reads a sandboxed role has no curl for", () => {
    const r = slackReadRules("/bin/slack-read.sh");
    expect(r).toContain("/bin/slack-read.sh history");
    expect(r).toContain("/bin/slack-read.sh replies");
    expect(r).toContain("every role");
  });

  test("it says how to take a Slack link apart", () => {
    expect(slackReadRules("/s.sh")).toContain("decimal point inserted before the last six digits");
  });

  test("public is joinable, private is the host-login command's job", () => {
    const r = slackReadRules("/s.sh");
    expect(r).toContain("PUBLIC channel you have not joined");
    expect(r).toContain("`read` command");
  });

  test("a denied tool must never be reported as a Slack permission", () => {
    // the failure this exists for: the tool policy refused `curl` and the bot
    // told a colleague "I do not have permission to read that channel", which
    // was false - it was a member of it
    expect(slackReadRules("/s.sh")).toContain("Never report a tool you were denied as a permission Slack refused you");
  });

  test("with no helper wired there is no block at all", () => {
    expect(slackReadRules(undefined)).toBe("");
  });
});
