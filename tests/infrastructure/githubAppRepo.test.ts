import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createGithubAppRepo } from "../../src/infrastructure/db/githubAppRepo.ts";

describe("githubAppRepo", () => {
  test("a delivery id is recorded once - a redelivery is not new", () => {
    const repo = createGithubAppRepo(openDatabase(":memory:"));
    expect(repo.record("d1", "{}", 1)).toBe(true);
    expect(repo.record("d1", "{}", 2)).toBe(false);
    expect(repo.claim(3).map((r) => r.id)).toEqual(["d1"]);
    expect(repo.claim(4)).toEqual([]);
    expect(repo.state("d1")).toBe("running");
  });

  test("recovery retries an unposted call and settles a posted one", () => {
    const repo = createGithubAppRepo(openDatabase(":memory:"));
    repo.record("a", '{"x":1}', 1);
    repo.record("b", '{"x":2}', 2);
    repo.claim(3);
    repo.markPosted("b", "C1", "1.1", 4);
    expect(repo.recover(5)).toEqual({ retried: 1, settled: 1 });
    expect(repo.state("a")).toBe("pending");
    expect(repo.state("b")).toBe("done");
  });

  test("settled ids are pruned after retention, and still dedupe until then", () => {
    const repo = createGithubAppRepo(openDatabase(":memory:"));
    repo.record("a", "{}", 1);
    repo.claim(2);
    repo.finish("a", "done", 3);
    repo.prune(1);
    expect(repo.record("a", "{}", 4)).toBe(false);
    repo.prune(10);
    expect(repo.state("a")).toBeUndefined();
  });

  test("threads are bound and count their comments", () => {
    const repo = createGithubAppRepo(openDatabase(":memory:"));
    repo.bind({ channelId: "C1", threadTs: "1.1", repo: "o/r", number: 7, installationId: 42 }, 1);
    repo.noteComment("C1", "1.1");
    expect(repo.thread("C1", "1.1")).toEqual({
      channelId: "C1",
      threadTs: "1.1",
      repo: "o/r",
      number: 7,
      installationId: 42,
      comments: 1,
    });
    expect(repo.thread("C1", "2.2")).toBeUndefined();
  });
});
