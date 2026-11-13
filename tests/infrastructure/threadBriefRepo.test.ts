import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createThreadBriefRepo } from "../../src/infrastructure/db/threadBriefRepo.ts";
import { briefRef } from "../../src/domain/threadBrief.ts";

const brief = (text: string, over: Partial<Parameters<ReturnType<typeof createThreadBriefRepo>["add"]>[0]> = {}) => ({
  fromChannel: "D0SRC",
  fromThread: "1.1",
  toChannel: "C0PUB",
  toThread: "2.2",
  author: "U0OWNER0001",
  text,
  ...over,
});

describe("thread brief repo", () => {
  test("a brief is unread for its target thread only, oldest first", () => {
    const repo = createThreadBriefRepo(openDatabase(":memory:"));
    repo.add(brief("first"), 10);
    repo.add(brief("second"), 20);
    repo.add(brief("elsewhere", { toThread: "9.9" }), 30);
    expect(repo.unread("C0PUB", "2.2").map((b) => b.text)).toEqual(["first", "second"]);
    expect(repo.unread("C0PUB", "9.9").map((b) => b.text)).toEqual(["elsewhere"]);
    expect(repo.unread("D0SRC", "1.1")).toEqual([]);
    expect(repo.unread("C0PUB", "2.2")[0]).toMatchObject({ fromChannel: "D0SRC", fromThread: "1.1", author: "U0OWNER0001", createdAt: 10 });
  });

  test("marking read hides only those ids and keeps the first read time", () => {
    const repo = createThreadBriefRepo(openDatabase(":memory:"));
    const a = repo.add(brief("a"), 1);
    repo.add(brief("b"), 2);
    repo.markRead([a], 50);
    repo.markRead([a], 99);
    expect(repo.unread("C0PUB", "2.2").map((b) => b.text)).toEqual(["b"]);
    repo.markRead([], 100);
    expect(repo.unread("C0PUB", "2.2")).toHaveLength(1);
  });

  test("both threads can answer the other by reference, nobody else can", () => {
    const repo = createThreadBriefRepo(openDatabase(":memory:"));
    repo.add(brief("hello"), 1);
    // the target resolves the source's reference, the source resolves the target's
    expect(repo.peer("C0PUB", "2.2", briefRef("D0SRC", "1.1"))).toEqual({ channelId: "D0SRC", threadTs: "1.1" });
    expect(repo.peer("D0SRC", "1.1", briefRef("C0PUB", "2.2"))).toEqual({ channelId: "C0PUB", threadTs: "2.2" });
    // a third thread never saw either reference
    expect(repo.peer("C0OTH", "3.3", briefRef("D0SRC", "1.1"))).toBeUndefined();
    expect(repo.peer("C0PUB", "2.2", "deadbeef00")).toBeUndefined();
  });

  test("a second brief on the same pair does not duplicate the link, and survives a reopen", () => {
    const db = openDatabase(":memory:");
    const repo = createThreadBriefRepo(db);
    repo.add(brief("one"), 1);
    repo.add(brief("two"), 2);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM thread_brief_links").get()?.n).toBe(2);
    expect(createThreadBriefRepo(db).unread("C0PUB", "2.2")).toHaveLength(2);
  });
});
