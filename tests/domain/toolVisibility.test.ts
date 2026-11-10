import { describe, expect, test } from "bun:test";
import { isHiddenAction, isNoiseTool, redactPaths, redactSecrets, REDACTED } from "../../src/domain/toolVisibility.ts";

describe("isHiddenAction", () => {
  test("the bot's silent self-actions leave no card", () => {
    expect(
      isHiddenAction(
        'curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" -d "channel=C1&timestamp=1.1&name=eyes" https://slack.com/api/reactions.add',
      ),
    ).toBe(true);
    expect(isHiddenAction("curl -s -X POST -d '{\"content\":\"x\"}' http://127.0.0.1:2002/api/learnings")).toBe(true);
  });

  test("anything aimed at the local host is hidden", () => {
    expect(isHiddenAction("curl http://localhost:2002/api/overview")).toBe(true);
    expect(isHiddenAction("curl http://127.0.0.1:9000/health")).toBe(true);
    expect(isHiddenAction("curl -g 'http://[::1]:2002/api/users'")).toBe(true);
  });

  test("real work still shows", () => {
    expect(isHiddenAction('curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/users.list"')).toBe(
      false,
    );
    expect(isHiddenAction("gh pr view https://github.com/o/r/pull/1")).toBe(false);
    expect(isHiddenAction("bun test")).toBe(false);
    expect(isHiddenAction(undefined)).toBe(false);
  });
});

describe("redactSecrets", () => {
  test("scrubs tokens that would otherwise be posted into a channel", () => {
    expect(redactSecrets("curl -H 'Authorization: Bearer xoxb-123456789012-abcdefghijkl'")).toContain(REDACTED);
    expect(redactSecrets("export ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf123456")).not.toContain("AbCdEf123456");
    expect(redactSecrets("gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123")).toContain(REDACTED);
    expect(redactSecrets("aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE")).toContain(REDACTED);
  });

  test("a shell variable is not a secret", () => {
    const cmd = 'curl -H "Authorization: Bearer $SLACK_BOT_TOKEN" https://slack.com/api/users.list';
    expect(redactSecrets(cmd)).toBe(cmd);
  });

  test("ordinary commands are untouched", () => {
    expect(redactSecrets("git log --oneline -5")).toBe("git log --oneline -5");
  });
});

describe("isNoiseTool", () => {
  test("the model's own plumbing leaves no card, real tools do", () => {
    expect(isNoiseTool("ToolSearch")).toBe(true);
    expect(isNoiseTool("TodoWrite")).toBe(true);
    expect(isNoiseTool("Bash")).toBe(false);
    expect(isNoiseTool("mcp__acme-pg-prod__execute_sql")).toBe(false);
  });
});

describe("redactPaths", () => {
  test("the workspace root and home directory are shortened", () => {
    expect(redactPaths("cd /Users/kai/Workspaces/acme-api && git grep x", "/Users/kai")).toBe(
      "cd $Workspaces/acme-api && git grep x",
    );
    expect(redactPaths("cat /Users/kai/.claude/x.md", "/Users/kai")).toBe("cat ~/.claude/x.md");
  });

  test("other paths are left alone", () => {
    expect(redactPaths("grep -n foo /tmp/survey.js", "/Users/kai")).toBe("grep -n foo /tmp/survey.js");
    expect(redactPaths("ls /", "")).toBe("ls /");
  });
});
