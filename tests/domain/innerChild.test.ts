import { describe, expect, test } from "bun:test";
import { STANDALONE_REVIEW_RULE } from "../../src/domain/selfUpdate.ts";
import {
  afterNotice,
  beforeNotice,
  byUrgency,
  fixPrompt,
  normaliseFingerprint,
  parseFindings,
  readOutcome,
  triageMessage,
} from "../../src/domain/innerChild.ts";

const item = (over: Record<string, unknown> = {}) => ({
  fingerprint: "Stream Dies",
  title: "stream dies on long replies",
  severity: "bug",
  channelId: "C1",
  threadTs: "1.2",
  evidence: "msg_too_long",
  hint: "stream.ts",
  ...over,
});

describe("parseFindings", () => {
  test("reads a bare array and normalises the fingerprint", () => {
    const [f] = parseFindings(JSON.stringify([item()]));
    expect(f?.fingerprint).toBe("stream-dies");
    expect(f?.severity).toBe("bug");
  });

  test("finds the array inside prose or a fence", () => {
    expect(parseFindings("here:\n```json\n" + JSON.stringify([item()]) + "\n```")).toHaveLength(1);
  });

  test("an empty answer, junk, or a bad item yields nothing rather than a guess", () => {
    expect(parseFindings("[]")).toEqual([]);
    expect(parseFindings("nothing to report")).toEqual([]);
    expect(parseFindings("[{not json")).toEqual([]);
    expect(parseFindings(JSON.stringify([item({ severity: "minor" }), item({ channelId: "" }), 3]))).toEqual([]);
  });

  test("falls back to the title for a missing fingerprint", () => {
    expect(parseFindings(JSON.stringify([item({ fingerprint: "" })]))[0]?.fingerprint).toBe(
      "stream-dies-on-long-replies",
    );
  });
});

test("critical sorts first", () => {
  const out = byUrgency(parseFindings(JSON.stringify([item(), item({ fingerprint: "b", severity: "critical" })])));
  expect(out.map((f) => f.fingerprint)).toEqual(["b", "stream-dies"]);
});

test("normaliseFingerprint is stable", () => {
  expect(normaliseFingerprint("  Foo__Bar!! ")).toBe("foo-bar");
});

describe("readOutcome", () => {
  test("only an explicit fixed counts as fixed", () => {
    expect(readOutcome("done\nRESULT: fixed")).toBe("fixed");
    expect(readOutcome("RESULT: not fixed")).toBe("not_fixed");
    expect(readOutcome("I think it works")).toBe("not_fixed");
  });
});

describe("messages", () => {
  const issue = {
    id: 7,
    title: "stream dies",
    severity: "critical" as const,
    evidence: "msg_too_long\nhint: stream.ts",
    sourceChannel: "C1",
    sourceThread: "1.2",
  };

  test("the before notice names the issue, the source and that no approval is needed", () => {
    const text = beforeNotice(issue);
    expect(text).toContain("#7");
    expect(text).toContain("*critical*");
    expect(text).toContain("archives/C1/p12");
    expect(text).toContain("no approval needed");
    expect(text).not.toContain("hint:");
  });

  test("the fix prompt carries the guard rails and the restart script", () => {
    const text = fixPrompt(issue, "/src", "/src/bin/restart.sh");
    expect(text).toContain("/src/bin/restart.sh");
    expect(text).toContain("never revert");
    expect(text).toContain("RESULT: fixed");
  });

  test("the fix runs in its own worktree and lands through a merged PR, never in the main folder", () => {
    const text = fixPrompt(issue, "/src", "/src/bin/restart.sh");
    expect(text).toContain("never edit /src itself");
    expect(text).toContain(`worktree add /src/.claude/worktrees/issue-${issue.id} -b fix/issue-${issue.id} origin/main`);
    expect(text).toContain("merge it yourself");
    expect(text).toContain("git -C /src pull --ff-only origin main");
    expect(text).not.toContain("do not commit");
    // the restart comes last, after the merge is pulled home
    expect(text.indexOf("pull --ff-only")).toBeLessThan(text.indexOf("/src/bin/restart.sh"));
    // a standalone reviewer reads the PR before it is merged
    expect(text).toContain(STANDALONE_REVIEW_RULE);
    expect(text.indexOf(STANDALONE_REVIEW_RULE)).toBeLessThan(text.indexOf("then merge it yourself"));
    // a review that never comes back clean ends the fix unmerged, with a result line
    expect(text).toContain("still not clean after 3 rounds, merge nothing");
  });

  test("after notices", () => {
    expect(afterNotice(7, "fixed")).toContain("fixed");
    expect(afterNotice(7, "not_fixed")).toContain("not fixed");
    expect(afterNotice(7, "failed", "boom")).toContain("boom");
  });

  test("the triage is told what is already known", () => {
    expect(triageMessage([], ["a: b"])).toContain("- a: b");
  });
});
