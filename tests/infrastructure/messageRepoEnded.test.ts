import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createReminderRepo } from "../../src/infrastructure/db/reminderRepo.ts";

describe("endedOnBot", () => {
  const repo = () => createMessageRepo(openDatabase(":memory:"));
  const add = (r: ReturnType<typeof repo>, role: "user" | "assistant", threadTs: string, at: number, channelId = "C1") =>
    r.append({ channelId, slackUserId: role === "user" ? "U1" : "assistant", role, content: "x", threadTs }, at);

  test("lists threads whose newest turn is the bot's, with the last person", () => {
    const r = repo();
    add(r, "user", "1.1", 100);
    add(r, "assistant", "1.1", 200);
    add(r, "user", "2.2", 100);
    add(r, "assistant", "2.2", 150);
    add(r, "user", "2.2", 300); // human spoke last
    add(r, "assistant", "", 200); // not a thread
    expect(r.endedOnBot(0, 1000, 10)).toEqual([{ channelId: "C1", threadTs: "1.1", lastAt: 200, slackUserId: "U1" }]);
  });

  test("respects the window and skips threads with no person", () => {
    const r = repo();
    add(r, "user", "1.1", 10);
    add(r, "assistant", "1.1", 20);
    add(r, "assistant", "3.3", 500);
    expect(r.endedOnBot(100, 1000, 10)).toEqual([]);
    expect(r.endedOnBot(0, 15, 10)).toEqual([]);
  });
});

describe("reminders waitingAt", () => {
  test("counts only waiting reminders in that thread", () => {
    const db = openDatabase(":memory:");
    const r = createReminderRepo(db);
    const base = { channelId: "C1", createdBy: "U1", targets: ["U1"], text: "t", dueAt: 10 };
    r.add({ ...base, threadTs: "1.1" }, 1);
    const done = r.add({ ...base, threadTs: "1.1" }, 1);
    r.settle(done.id, "sent", 2);
    r.add({ ...base, threadTs: "2.2" }, 1);
    expect(r.waitingAt("C1", "1.1")).toBe(1);
    expect(r.waitingAt("C1", "9.9")).toBe(0);
  });
});
