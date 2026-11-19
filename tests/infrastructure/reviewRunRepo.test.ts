import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createReviewRunRepo, type NewReviewRun } from "../../src/infrastructure/db/reviewRunRepo.ts";

const run: NewReviewRun = {
  prKey: "o/r#7",
  headSha: "abc1234",
  identity: "app",
  url: "https://github.com/o/r/pull/7",
  repo: "o/r",
  number: 7,
  title: "add thing",
  requester: "dev",
  note: "",
  installationId: 9,
};

describe("review run repo", () => {
  test("one review per PR head per identity: a second claim finds the row and gets nothing", () => {
    const db = openDatabase(":memory:");
    const repo = createReviewRunRepo(db);
    expect(repo.claim(run, 100)).toMatchObject({ id: 1, state: "claimed", identity: "app", requester: "dev", installationId: 9 });
    expect(repo.claim(run, 101)).toBeUndefined();
    // another identity, another head: each its own review
    const human = repo.claim({ ...run, identity: "human" }, 102);
    const next = repo.claim({ ...run, headSha: "def5678" }, 103);
    expect(human?.identity).toBe("human");
    expect(next?.headSha).toBe("def5678");
    expect(new Set([1, human?.id, next?.id]).size).toBe(3);
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBeGreaterThanOrEqual(43);
  });

  test("only a failed review can be claimed again, and it starts clean", () => {
    const repo = createReviewRunRepo(openDatabase(":memory:"));
    const first = repo.claim(run, 100);
    if (!first) throw new Error("no claim");
    repo.setRequesterSlack(first.id, "U1", 101);
    repo.setAsk(first.id, "C1", "1.1", "no-token", 101);
    for (const state of ["asking", "running", "done", "rejected"] as const) {
      repo.move(first.id, ["claimed", "asking", "running", "done", "rejected"], state, 110);
      expect(repo.claim(run, 120)).toBeUndefined();
    }
    repo.move(first.id, ["rejected"], "failed", 130);
    const again = repo.claim({ ...run, requester: "other" }, 140);
    expect(again).toMatchObject({ id: first.id, state: "claimed", requester: "other", requesterSlack: "", askTs: "" });
  });

  test("a move only happens from the states named, so two presses cannot both win", () => {
    const repo = createReviewRunRepo(openDatabase(":memory:"));
    const r = repo.claim(run, 100);
    if (!r) throw new Error("no claim");
    expect(repo.move(r.id, ["asking"], "running", 101)).toBe(false);
    repo.move(r.id, ["claimed"], "asking", 102);
    expect(repo.move(r.id, ["asking"], "running", 103)).toBe(true);
    expect(repo.move(r.id, ["asking"], "rejected", 104)).toBe(false);
    expect(repo.get(r.id)?.state).toBe("running");
    expect(repo.move(r.id, [], "done", 105)).toBe(false);
  });

  test("a restart fails what was cut off mid-way and leaves a pending question alone", () => {
    const repo = createReviewRunRepo(openDatabase(":memory:"));
    const a = repo.claim(run, 100);
    const b = repo.claim({ ...run, headSha: "b" }, 100);
    const c = repo.claim({ ...run, headSha: "c" }, 100);
    if (!a || !b || !c) throw new Error("no claim");
    repo.move(a.id, ["claimed"], "running", 101);
    repo.move(b.id, ["claimed"], "asking", 101);
    expect(repo.recover(200)).toBe(2); // a (running) and c (claimed)
    expect(repo.get(a.id)?.state).toBe("failed");
    expect(repo.get(b.id)?.state).toBe("asking");
    expect(repo.get(c.id)?.state).toBe("failed");
  });

  test("a PR keeps one thread: the first one wins", () => {
    const repo = createReviewRunRepo(openDatabase(":memory:"));
    expect(repo.thread("o/r#7")).toBeUndefined();
    expect(repo.setThread("o/r#7", { channelId: "C1", threadTs: "1.1" }, 100)).toBe(true);
    expect(repo.setThread("o/r#7", { channelId: "C2", threadTs: "2.2" }, 101)).toBe(false);
    expect(repo.thread("o/r#7")).toEqual({ channelId: "C1", threadTs: "1.1" });
  });
});
