import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createTurnLogRepo, type NewTurn, type TurnLogRepo } from "../../src/infrastructure/db/turnLogRepo.ts";

let db: DbClient;
let turns: TurnLogRepo;

const turn = (over: Partial<NewTurn> = {}): NewTurn => ({
  runId: "r1",
  channelId: "C1",
  threadTs: "9.9",
  slackUserId: "U1",
  kind: "chat",
  request: "why is the form slow",
  outcome: "ok",
  error: "",
  startedAt: 1_000,
  endedAt: 2_000,
  ...over,
});

beforeEach(() => {
  db = openDatabase(":memory:");
  turns = createTurnLogRepo(db);
});

describe("turnLogRepo", () => {
  test("records a turn and reads it back newest first", () => {
    turns.add(turn({ endedAt: 1 }));
    turns.add(turn({ endedAt: 5, request: "second" }));
    expect(turns.since(0).map((t) => t.request)).toEqual(["second", "why is the form slow"]);
  });

  test("the window is respected", () => {
    turns.add(turn({ endedAt: 10 }));
    expect(turns.since(50)).toHaveLength(0);
  });

  test("a thread that failed and then worked is not stuck", () => {
    turns.add(turn({ endedAt: 10, outcome: "failed", error: "disk I/O error" }));
    turns.add(turn({ endedAt: 20, outcome: "ok" }));
    expect(turns.stuckThreads(0)).toHaveLength(0);
  });

  test("a thread whose newest turn failed IS stuck, and keeps its request", () => {
    turns.add(turn({ endedAt: 10, outcome: "ok" }));
    turns.add(turn({ endedAt: 20, outcome: "failed", error: "boom", request: "fix the view" }));
    const stuck = turns.stuckThreads(0);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.request).toBe("fix the view");
    expect(stuck[0]?.error).toBe("boom");
  });

  test("a stopped turn is not stuck - a person chose it - but still shows in the window", () => {
    turns.add(turn({ endedAt: 20, outcome: "stopped" }));
    expect(turns.stuckThreads(0)).toHaveLength(0);
    expect(turns.since(0)).toHaveLength(1);
  });

  test("a thread that failed and was then stopped is not stuck", () => {
    turns.add(turn({ endedAt: 10, outcome: "failed", error: "boom" }));
    turns.add(turn({ endedAt: 20, outcome: "stopped" }));
    expect(turns.stuckThreads(0)).toHaveLength(0);
  });

  test("threads are judged separately", () => {
    turns.add(turn({ threadTs: "1.1", endedAt: 10, outcome: "failed" }));
    turns.add(turn({ threadTs: "2.2", endedAt: 11, outcome: "ok" }));
    expect(turns.stuckThreads(0).map((t) => t.threadTs)).toEqual(["1.1"]);
  });

  test("the newest turn of a thread is findable, for a retry", () => {
    turns.add(turn({ endedAt: 10, request: "old" }));
    turns.add(turn({ endedAt: 20, request: "newest" }));
    expect(turns.latestInThread("C1", "9.9")?.request).toBe("newest");
    expect(turns.latestInThread("C1", "nope")).toBeUndefined();
  });

  test("a long request is truncated rather than stored whole", () => {
    turns.add(turn({ request: "x".repeat(5000) }));
    expect(turns.since(0)[0]?.request.length).toBe(2000);
  });

  test("an unknown outcome reads as ok rather than throwing", () => {
    db.query("INSERT INTO turn_log (channel_id, outcome, started_at, ended_at) VALUES ('C1','weird',1,2)").run();
    expect(turns.since(0)[0]?.outcome).toBe("ok");
  });
});
