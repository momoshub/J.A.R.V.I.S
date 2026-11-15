import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createBugReportRepo, type NewBugReport } from "../../src/infrastructure/db/bugReportRepo.ts";

const base: NewBugReport = { fingerprint: "t|issue", threadLink: "https://acme.slack.com/archives/C1/p1", issue: "issue", summary: "why", plan: "fix", reportedIn: "C1" };

describe("bug report repo", () => {
  test("add stores a pending row that a restart keeps, and the schema sets the version", () => {
    const db = openDatabase(":memory:");
    const b = createBugReportRepo(db).add(base, 100);
    expect(b).toMatchObject({ id: 1, state: "pending", createdAt: 100, decidedAt: 0, noticeChannel: "" });
    expect(createBugReportRepo(db).get(1)?.issue).toBe("issue");
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBeGreaterThanOrEqual(41);
  });

  test("recent finds the newest of a fingerprint inside the window only", () => {
    const repo = createBugReportRepo(openDatabase(":memory:"));
    repo.add(base, 100);
    repo.add({ ...base, fingerprint: "other" }, 150);
    expect(repo.recent("t|issue", 100)?.id).toBe(1);
    expect(repo.recent("t|issue", 101)).toBeUndefined();
    expect(repo.countSince(120)).toBe(1);
  });

  test("byState lists the newest reports of one state, newest first, up to the limit", () => {
    const repo = createBugReportRepo(openDatabase(":memory:"));
    repo.add(base, 100);
    repo.add({ ...base, fingerprint: "b" }, 110);
    repo.add({ ...base, fingerprint: "c" }, 120);
    repo.decide(1, "rejected", 200);
    repo.decide(2, "rejected", 210);
    expect(repo.byState("rejected", 10).map((r) => r.id)).toEqual([2, 1]);
    expect(repo.byState("rejected", 1).map((r) => r.id)).toEqual([2]);
    expect(repo.byState("pending", 10).map((r) => r.id)).toEqual([3]);
    expect(repo.byState("approved", 10)).toEqual([]);
  });

  test("decide moves a pending row once and never back", () => {
    const repo = createBugReportRepo(openDatabase(":memory:"));
    repo.add(base, 100);
    expect(repo.decide(1, "approved", 200)).toBe(true);
    expect(repo.decide(1, "rejected", 300)).toBe(false);
    expect(repo.get(1)).toMatchObject({ state: "approved", decidedAt: 200 });
  });

  test("discard removes the row", () => {
    const repo = createBugReportRepo(openDatabase(":memory:"));
    repo.add(base, 100);
    repo.discard(1);
    expect(repo.get(1)).toBeUndefined();
  });
});
