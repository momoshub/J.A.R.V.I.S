import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createThreadBriefRepo } from "../../src/infrastructure/db/threadBriefRepo.ts";

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
    expect(repo.unread("C0PUB", "2.2", "sandbox").map((b) => b.text)).toEqual(["first", "second"]);
    expect(repo.unread("C0PUB", "9.9", "sandbox").map((b) => b.text)).toEqual(["elsewhere"]);
    expect(repo.unread("D0SRC", "1.1", "sandbox")).toEqual([]);
    expect(repo.unread("C0PUB", "2.2", "sandbox")[0]).toMatchObject({ fromChannel: "D0SRC", fromThread: "1.1", author: "U0OWNER0001", createdAt: 10 });
  });

  test("marking read hides only those ids, for that tier only", () => {
    const repo = createThreadBriefRepo(openDatabase(":memory:"));
    const a = repo.add(brief("a"), 1);
    repo.add(brief("b"), 2);
    repo.markRead([a], "full", 50);
    repo.markRead([a], "full", 99);
    expect(repo.unread("C0PUB", "2.2", "full").map((b) => b.text)).toEqual(["b"]);
    // the other tier's session never carried it
    expect(repo.unread("C0PUB", "2.2", "sandbox").map((b) => b.text)).toEqual(["a", "b"]);
    repo.markRead([], "full", 100);
    expect(repo.unread("C0PUB", "2.2", "full")).toHaveLength(1);
  });

  test("recent returns the newest few for the thread, read or not, oldest first", () => {
    const repo = createThreadBriefRepo(openDatabase(":memory:"));
    const ids = [1, 2, 3].map((n) => repo.add(brief(`n${n}`), n));
    repo.add(brief("elsewhere", { toThread: "9.9" }), 4);
    repo.markRead(ids, "full", 10);
    expect(repo.recent("C0PUB", "2.2", 2).map((b) => b.text)).toEqual(["n2", "n3"]);
    expect(repo.recent("C0PUB", "2.2", 10).map((b) => b.text)).toEqual(["n1", "n2", "n3"]);
    expect(repo.recent("C0PUB", "2.2", 0)).toEqual([]);
  });

  test("both threads can answer the other by reference, nobody else can", () => {
    const repo = createThreadBriefRepo(openDatabase(":memory:"));
    repo.add(brief("hello"), 1);
    // the target resolves the source's reference, the source resolves the target's
    expect(repo.peer("C0PUB", "2.2", repo.ref("D0SRC", "1.1"))).toEqual({ channelId: "D0SRC", threadTs: "1.1" });
    expect(repo.peer("D0SRC", "1.1", repo.ref("C0PUB", "2.2"))).toEqual({ channelId: "C0PUB", threadTs: "2.2" });
    // a third thread never saw either reference
    expect(repo.peer("C0OTH", "3.3", repo.ref("D0SRC", "1.1"))).toBeUndefined();
    expect(repo.peer("C0PUB", "2.2", "deadbeef00")).toBeUndefined();
  });

  test("the reference is an HMAC under a per-database secret, and stays put across a reopen", () => {
    const db = openDatabase(":memory:");
    const repo = createThreadBriefRepo(db);
    const ref = repo.ref("D0SRC", "1.1");
    const plain = new Bun.CryptoHasher("sha256").update("brief-ref:D0SRC:1.1").digest("hex").slice(0, 10);
    expect(ref).toMatch(/^[0-9a-f]{10}$/);
    expect(ref).not.toBe(plain);
    expect(createThreadBriefRepo(db).ref("D0SRC", "1.1")).toBe(ref);
    // another bot's database mints another secret, so the same source gets another reference
    expect(createThreadBriefRepo(openDatabase(":memory:")).ref("D0SRC", "1.1")).not.toBe(ref);
  });

  test("a second brief on the same pair does not duplicate the link, and survives a reopen", () => {
    const db = openDatabase(":memory:");
    const repo = createThreadBriefRepo(db);
    repo.add(brief("one"), 1);
    repo.add(brief("two"), 2);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM thread_brief_links").get()?.n).toBe(2);
    expect(createThreadBriefRepo(db).unread("C0PUB", "2.2", "sandbox")).toHaveLength(2);
  });
});
