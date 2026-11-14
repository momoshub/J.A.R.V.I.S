import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createJourneyRepo, type NewJourney } from "../../src/infrastructure/db/journeyRepo.ts";

const base: NewJourney = {
  title: "Ship it",
  status: "doing",
  area: "Jarvis",
  channelId: "C1",
  threadTs: "1.0",
  permalink: "",
  prs: [],
  progress: 0,
  now: "",
  next: "",
  createdBy: "U0OWNER0001",
};

describe("journey repo", () => {
  test("add stores the row and a created event; a restart keeps both", () => {
    const db = openDatabase(":memory:");
    const j = createJourneyRepo(db).add({ ...base, prs: ["https://github.com/a/b/pull/1"] }, 100);
    expect(j).toMatchObject({ id: 1, title: "Ship it", status: "doing", createdAt: 100, updatedAt: 100, doneAt: 0 });
    const again = createJourneyRepo(db);
    expect(again.get(1)?.prs).toEqual(["https://github.com/a/b/pull/1"]);
    expect(again.events(1).map((e) => e.kind)).toEqual(["created", "pr"]);
  });

  test("the schema is a no-op on rerun and sets the version", () => {
    const db = openDatabase(":memory:");
    createJourneyRepo(db).add(base, 1);
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'journey%'").all();
    expect(tables.map((t) => t.name).sort()).toEqual(["journey_events", "journeys"]);
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBeGreaterThanOrEqual(38);
  });

  test("update on a missing journey is undefined and writes nothing", () => {
    const repo = createJourneyRepo(openDatabase(":memory:"));
    expect(repo.update(5, { progress: 5 }, 1, "U1")).toBeUndefined();
    expect(repo.eventsSince(0)).toHaveLength(0);
  });

  test("done pins progress to 100 and stamps done_at once", () => {
    const repo = createJourneyRepo(openDatabase(":memory:"));
    repo.add(base, 1);
    repo.update(1, { status: "done" }, 50, "U1");
    repo.update(1, { note: "again" }, 90, "U1");
    expect(repo.get(1)).toMatchObject({ status: "done", progress: 100, doneAt: 50, updatedAt: 90 });
  });

  test("list filters by status, area (any case) and recency, newest touched first", () => {
    const repo = createJourneyRepo(openDatabase(":memory:"));
    repo.add({ ...base, title: "a" }, 10);
    repo.add({ ...base, title: "b", area: "Ops", status: "planned" }, 20);
    repo.add({ ...base, title: "c" }, 30);
    repo.update(1, { progress: 5 }, 40, "U1");
    expect(repo.list().map((j) => j.title)).toEqual(["a", "c", "b"]);
    expect(repo.list({ statuses: ["planned"] }).map((j) => j.title)).toEqual(["b"]);
    expect(repo.list({ area: "ops" }).map((j) => j.title)).toEqual(["b"]);
    expect(repo.list({ since: 35 }).map((j) => j.title)).toEqual(["a"]);
    expect(repo.list({ limit: 1 })).toHaveLength(1);
  });

  test("events: the last N stay in order, and eventsSince reads across journeys", () => {
    const repo = createJourneyRepo(openDatabase(":memory:"));
    repo.add(base, 10);
    repo.add({ ...base, title: "other" }, 20);
    for (let p = 10; p <= 50; p += 10) repo.update(1, { progress: p }, 100 + p, "U1");
    expect(repo.events(1, 2).map((e) => e.text)).toEqual(["40%", "50%"]);
    expect(repo.eventsSince(20).map((e) => e.journeyId)).toEqual([2, 1, 1, 1, 1, 1]);
    expect(repo.eventsSince(0, 2)).toHaveLength(2);
  });

  test("a bad stored status or kind reads back as a safe default", () => {
    const db = openDatabase(":memory:");
    const repo = createJourneyRepo(db);
    repo.add(base, 1);
    db.exec("UPDATE journeys SET status = 'weird', prs = 'not json'");
    db.exec("UPDATE journey_events SET kind = 'weird'");
    expect(repo.get(1)).toMatchObject({ status: "doing", prs: [] });
    expect(repo.events(1)[0]?.kind).toBe("note");
  });
});
