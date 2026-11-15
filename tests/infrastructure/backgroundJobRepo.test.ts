import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createBackgroundJobRepo } from "../../src/infrastructure/db/backgroundJobRepo.ts";

const job = { channelId: "D1", threadTs: "1.1", slackUserId: "U1", tasks: ["write the post"] };

describe("background job repo", () => {
  test("set replaces the thread's list and a restart keeps it", () => {
    const db = openDatabase(":memory:");
    const repo = createBackgroundJobRepo(db);
    repo.set(job, 100);
    repo.set({ ...job, tasks: ["a", "b"] }, 200);
    expect(createBackgroundJobRepo(db).list()).toEqual([{ ...job, tasks: ["a", "b"], updatedAt: 200 }]);
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBeGreaterThanOrEqual(42);
  });

  test("an empty list removes the row", () => {
    const repo = createBackgroundJobRepo(openDatabase(":memory:"));
    repo.set(job, 100);
    repo.set({ ...job, tasks: [] }, 200);
    expect(repo.list()).toEqual([]);
  });

  test("claim hands the row to exactly one caller", () => {
    const repo = createBackgroundJobRepo(openDatabase(":memory:"));
    repo.set(job, 100);
    expect(repo.claim("D1", "1.1")?.tasks).toEqual(["write the post"]);
    expect(repo.claim("D1", "1.1")).toBeUndefined();
  });

  test("threads are separate rows", () => {
    const repo = createBackgroundJobRepo(openDatabase(":memory:"));
    repo.set(job, 100);
    repo.set({ ...job, threadTs: "2.2" }, 100);
    expect(repo.claim("D1", "2.2")).toBeDefined();
    expect(repo.list().map((j) => j.threadTs)).toEqual(["1.1"]);
  });
});
