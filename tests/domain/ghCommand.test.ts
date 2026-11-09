import { describe, expect, test } from "bun:test";
import { postedBody } from "../../src/domain/ghCommand.ts";

const PR = "https://github.com/o/r/pull/1";

describe("postedBody", () => {
  test("inline --body, double quoted", () => {
    expect(postedBody(`gh pr comment ${PR} --body "looks good to me"`, "comment")).toBe("looks good to me");
  });

  test("inline --body, single quoted and =-joined", () => {
    expect(postedBody(`gh pr comment ${PR} --body='ship it'`, "comment")).toBe("ship it");
  });

  test("unescapes what the shell would have", () => {
    expect(postedBody(`gh pr comment ${PR} --body "the \\"fix\\" works"`, "comment")).toBe('the "fix" works');
  });

  test("heredoc written in the same command, then --body-file", () => {
    const cmd = [
      "cat > /tmp/review-2149.md <<'EOF'",
      "The import fix is right.",
      "",
      "The HMAC half is not.",
      "EOF",
      `gh pr review ${PR} --request-changes --body-file /tmp/review-2149.md 2>&1`,
    ].join("\n");
    expect(postedBody(cmd, "request-changes")).toBe("The import fix is right.\n\nThe HMAC half is not.");
  });

  test("picks the heredoc matching the action's own file", () => {
    const cmd = [
      "cat > /tmp/comment.md <<'BODYEOF'",
      "the general review",
      "BODYEOF",
      "cat > /tmp/blockers.md <<'BODYEOF'",
      "the blocker list",
      "BODYEOF",
      `gh pr comment ${PR} --body-file /tmp/comment.md`,
      `gh pr review ${PR} --request-changes --body-file /tmp/blockers.md`,
    ].join("\n");
    expect(postedBody(cmd, "comment")).toBe("the general review");
    expect(postedBody(cmd, "request-changes")).toBe("the blocker list");
  });

  test("undefined when the action is not in the command", () => {
    expect(postedBody(`gh pr review ${PR} --approve`, "comment")).toBeUndefined();
    expect(postedBody(`gh pr comment ${PR} --body "hi"`, "request-changes")).toBeUndefined();
  });

  test("undefined when the body was written by some earlier command", () => {
    expect(postedBody(`gh pr comment ${PR} --body-file /tmp/written-elsewhere.md`, "comment")).toBeUndefined();
  });

  test("an approve carrying a body-file does not leak into the comment action", () => {
    expect(postedBody(`gh pr review ${PR} --approve`, "request-changes")).toBeUndefined();
  });

  test("a double-quoted body that spans lines is read whole, not cut at the first newline", () => {
    const cmd = `gh pr comment ${PR} --body "good to merge\n\n- nothing blocking\n- CI is green"`;
    expect(postedBody(cmd, "comment")).toBe("good to merge\n\n- nothing blocking\n- CI is green");
  });

  test("an unterminated quoted body is unreadable, never the first word with its quote", () => {
    expect(postedBody(`gh pr comment ${PR} --body "good to merge`, "comment")).toBeUndefined();
  });

  test("a bare word body still works", () => {
    expect(postedBody(`gh pr comment ${PR} --body lgtm`, "comment")).toBe("lgtm");
  });

  test("a --body-file comment does not borrow the --body of a later command", () => {
    const cmd = [
      "cat > /tmp/c.md <<'EOF'",
      "the review",
      "EOF",
      `gh pr comment ${PR} --body-file /tmp/c.md`,
      `gh issue create --title t --body "follow-up"`,
    ].join("\n");
    expect(postedBody(cmd, "comment")).toBe("the review");
  });
});
