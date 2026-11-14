import { expect, test } from "bun:test";
import { openDatabase } from "../../../src/infrastructure/db/client.ts";
import { migrate } from "../../../src/infrastructure/db/schema.ts";
import { createThreadSessionRepo } from "../../../src/infrastructure/db/threadSessionRepo.ts";

test("move rebinds every tier of a thread to the new key and leaves other threads alone", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const repo = createThreadSessionRepo(db);
  repo.claim("D1", "100.000007", "full", "sess-a", "100.000007", 1, "h");
  repo.claim("D1", "100.000007", "sandbox", "sess-b", "100.000007", 1, "h");
  repo.claim("D1", "200.5", "full", "other", "200.5", 1, "h");

  repo.move("D1", "100.000007", "D1", "300.1", "300.1");

  expect(repo.find("D1", "100.000007", "full")).toBeUndefined();
  expect(repo.find("D1", "300.1", "full")?.sessionId).toBe("sess-a");
  expect(repo.find("D1", "300.1", "full")?.lastTs).toBe("300.1");
  expect(repo.find("D1", "300.1", "sandbox")?.sessionId).toBe("sess-b");
  expect(repo.find("D1", "200.5", "full")?.sessionId).toBe("other");
});

test("watches and reminders of a made-up thread can be counted and re-bound", async () => {
  const { createWatchRepo } = await import("../../../src/infrastructure/db/watchRepo.ts");
  const { createReminderRepo } = await import("../../../src/infrastructure/db/reminderRepo.ts");
  const db = openDatabase(":memory:");
  const watches = createWatchRepo(db);
  const reminders = createReminderRepo(db);
  watches.add({ channelId: "D1", threadTs: "100.000007", slackUserId: "U1", note: "n", check: "true", everyMs: 60_000, deadlineAt: 9e12, createdAt: 1 }, 1);
  watches.add({ channelId: "D1", threadTs: "200.5", slackUserId: "U1", note: "n", check: "true", everyMs: 60_000, deadlineAt: 9e12, createdAt: 1 }, 1);
  reminders.add({ channelId: "D1", threadTs: "100.000007", createdBy: "U1", targets: ["U1"], text: "t", dueAt: 5 }, 1);

  expect(watches.waitingAt("D1", "100.000007")).toBe(1);
  expect(watches.rebind("D1", "100.000007", "300.1")).toBe(1);
  expect(watches.waitingAt("D1", "100.000007")).toBe(0);
  expect(watches.waitingAt("D1", "300.1")).toBe(1);
  expect(watches.waitingAt("D1", "200.5")).toBe(1);

  expect(reminders.rebind("D1", "100.000007", "")).toBe(1);
  expect(reminders.waiting()[0]?.threadTs).toBe("");
});
