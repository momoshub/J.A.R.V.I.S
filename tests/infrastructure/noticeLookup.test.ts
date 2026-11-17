import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createBugReportRepo } from "../../src/infrastructure/db/bugReportRepo.ts";
import { createCommandApprovalRepo } from "../../src/infrastructure/db/commandApprovalRepo.ts";
import { createLearningsRepo } from "../../src/infrastructure/db/learningsRepo.ts";
import { createNoticeLookup } from "../../src/infrastructure/db/noticeLookup.ts";

describe("noticeLookup", () => {
  test("a stored notice is found by channel and ts, in any of the flows' tables", () => {
    const db = openDatabase(":memory:");
    const lookup = createNoticeLookup(db);
    const learnings = createLearningsRepo(db);
    const approvals = createCommandApprovalRepo(db);
    const l = learnings.add("a fact", "agent", 1, "pending");
    learnings.setNotice(l.id, "C1", "10.1");
    const a = approvals.open({ slackUserId: "U1", displayName: "x", channelId: "C1", threadTs: "1.1", line: "do" }, 1);
    approvals.setNotice(a.id, "D2", "20.2");
    expect(lookup("C1", "10.1")).toBe(true);
    expect(lookup("D2", "20.2")).toBe(true);
  });

  test("a bug report's approval notice is found too", () => {
    const db = openDatabase(":memory:");
    const bugs = createBugReportRepo(db);
    const b = bugs.add({ fingerprint: "t|issue", threadLink: "https://acme.slack.com/archives/C1/p1", issue: "issue", summary: "why", plan: "fix", reportedIn: "C1" }, 1);
    bugs.setNotice(b.id, "C3", "30.3");
    expect(createNoticeLookup(db)("C3", "30.3")).toBe(true);
  });

  test("anything else is not: another ts, the right ts in another channel, empty values", () => {
    const db = openDatabase(":memory:");
    const lookup = createNoticeLookup(db);
    const learnings = createLearningsRepo(db);
    const l = learnings.add("a fact", "agent", 1, "pending");
    expect(lookup("", "")).toBe(false);
    learnings.setNotice(l.id, "C1", "10.1");
    expect(lookup("C1", "10.2")).toBe(false);
    expect(lookup("C2", "10.1")).toBe(false);
    expect(lookup("C1", "")).toBe(false);
  });

  test("a learning sent back to pending no longer holds a notice (the old message can no longer be pressed, the row does not point at it)", () => {
    const db = openDatabase(":memory:");
    const lookup = createNoticeLookup(db);
    const learnings = createLearningsRepo(db);
    const l = learnings.add("a fact", "agent", 1, "pending");
    learnings.setNotice(l.id, "C1", "10.1");
    learnings.update(l.id, "reworded", "pending");
    expect(lookup("C1", "10.1")).toBe(false);
  });
});
