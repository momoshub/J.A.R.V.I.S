import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createReminderRepo, type ReminderRepo } from "../../src/infrastructure/db/reminderRepo.ts";
import { createReminderSender, MAX_POST_ATTEMPTS } from "../../src/application/reminders.ts";

let db: DbClient;
let reminders: ReminderRepo;
let now: number;
let posts: { channel: string; text: string; thread?: string }[];

const add = (over: Partial<Parameters<ReminderRepo["add"]>[0]> = {}) =>
  reminders.add(
    { channelId: "C1", threadTs: "9.9", createdBy: "U1", targets: ["U1"], text: "check the deploy", dueAt: now + 60_000, ...over },
    now,
  );

const sender = (fail = false) =>
  createReminderSender({
    reminders,
    clock: () => now,
    post: async (channel, text, thread) => {
      if (fail) throw new Error("channel_not_found");
      posts.push({ channel, text, thread });
    },
  });

beforeEach(() => {
  db = openDatabase(":memory:");
  reminders = createReminderRepo(db);
  now = 1_000_000;
  posts = [];
});

describe("reminder sender", () => {
  test("nothing is posted before it is due", async () => {
    add();
    await sender().tick();
    expect(posts).toHaveLength(0);
  });

  test("posts once when due, in its thread, and is done", async () => {
    const r = add();
    now += 60_000;
    const s = sender();
    await s.tick();
    await s.tick();
    expect(posts).toEqual([{ channel: "C1", text: "⏰ <@U1> reminder: check the deploy", thread: "9.9" }]);
    expect(reminders.get(r.id)?.state).toBe("sent");
  });

  test("one set outside a thread posts in the channel", async () => {
    add({ threadTs: "" });
    now += 60_000;
    await sender().tick();
    expect(posts[0]?.thread).toBeUndefined();
  });

  test("a cancelled one never posts", async () => {
    const r = add();
    reminders.settle(r.id, "cancelled", now);
    now += 60_000;
    await sender().tick();
    expect(posts).toHaveLength(0);
  });

  test("a failed post is retried, then given up on", async () => {
    const r = add();
    for (let i = 0; i < MAX_POST_ATTEMPTS; i++) {
      now += 120_000;
      await sender(true).tick();
    }
    expect(reminders.get(r.id)?.state).toBe("failed");
    expect(reminders.get(r.id)?.lastError).toBe("channel_not_found");
  });

  test("waitingFor finds what you set and what is aimed at you", () => {
    add({ createdBy: "U1", targets: ["U2"] });
    add({ createdBy: "U3", targets: ["U9", "U1"] });
    add({ createdBy: "U3", targets: ["U11"] });
    expect(reminders.waitingFor("U1")).toHaveLength(2);
    expect(reminders.waitingFor("U11")).toHaveLength(1);
  });
});

describe("reminder sender, when the database itself fails", () => {
  test("a failed read of due reminders is handed over, not thrown", async () => {
    const swapped = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR_VNODE" });
    const errors: unknown[] = [];
    const s = createReminderSender({
      reminders: { ...reminders, due: () => { throw swapped; } },
      clock: () => now,
      post: async () => {},
      onError: (e) => void errors.push(e),
    });
    await expect(s.tick()).resolves.toBeUndefined();
    expect(errors).toEqual([swapped]);
  });
});
