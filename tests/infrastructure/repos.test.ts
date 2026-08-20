import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import type { AllowedUser } from "../../src/domain/types.ts";

let db: DbClient;
beforeEach(() => {
  db = openDatabase(":memory:");
});

const user = (over: Partial<AllowedUser> = {}): AllowedUser => ({
  slackId: "U1",
  role: "member",
  displayName: "Kai",
  addedBy: "system",
  createdAt: 100,
  ...over,
});

describe("userRepo", () => {
  test("upsert then get round-trips", () => {
    const repo = createUserRepo(db);
    repo.upsert(user());
    expect(repo.get("U1")).toEqual(user());
  });

  test("upsert updates role and name but not addedBy/createdAt", () => {
    const repo = createUserRepo(db);
    repo.upsert(user());
    repo.upsert(user({ role: "admin", displayName: "Boss", addedBy: "x", createdAt: 999 }));
    const got = repo.get("U1");
    expect(got?.role).toBe("admin");
    expect(got?.displayName).toBe("Boss");
    expect(got?.addedBy).toBe("system");
    expect(got?.createdAt).toBe(100);
  });

  test("setRole and setDisplayName", () => {
    const repo = createUserRepo(db);
    repo.upsert(user());
    repo.setRole("U1", "admin");
    repo.setDisplayName("U1", "Tony");
    const got = repo.get("U1");
    expect(got?.role).toBe("admin");
    expect(got?.displayName).toBe("Tony");
  });

  test("list is ordered by creation", () => {
    const repo = createUserRepo(db);
    repo.upsert(user({ slackId: "U2", createdAt: 200 }));
    repo.upsert(user({ slackId: "U1", createdAt: 100 }));
    expect(repo.list().map((u) => u.slackId)).toEqual(["U1", "U2"]);
  });

  test("remove deletes", () => {
    const repo = createUserRepo(db);
    repo.upsert(user());
    repo.remove("U1");
    expect(repo.get("U1")).toBeUndefined();
  });
});

describe("messageRepo", () => {
  test("append returns a stored message with id", () => {
    const repo = createMessageRepo(db);
    const stored = repo.append(
      { channelId: "C1", slackUserId: "U1", role: "user", content: "hi" },
      100,
    );
    expect(stored.id).toBeGreaterThan(0);
    expect(stored.content).toBe("hi");
    expect(stored.createdAt).toBe(100);
  });

  test("recentForChannel returns oldest-first, windowed", () => {
    const repo = createMessageRepo(db);
    for (let i = 1; i <= 5; i++) {
      repo.append(
        { channelId: "C1", slackUserId: "U1", role: "user", content: `m${i}` },
        i,
      );
    }
    const recent = repo.recentForChannel("C1", 3);
    expect(recent.map((m) => m.content)).toEqual(["m3", "m4", "m5"]);
  });

  test("isolates by channel", () => {
    const repo = createMessageRepo(db);
    repo.append({ channelId: "C1", slackUserId: "U1", role: "user", content: "a" }, 1);
    repo.append({ channelId: "C2", slackUserId: "U1", role: "user", content: "b" }, 2);
    expect(repo.recentForChannel("C1", 10)).toHaveLength(1);
    expect(repo.recentForChannel("C2", 10)).toHaveLength(1);
  });

  test("clearChannel removes and reports count", () => {
    const repo = createMessageRepo(db);
    repo.append({ channelId: "C1", slackUserId: "U1", role: "user", content: "a" }, 1);
    repo.append({ channelId: "C1", slackUserId: "U1", role: "user", content: "b" }, 2);
    expect(repo.clearChannel("C1")).toBe(2);
    expect(repo.recentForChannel("C1", 10)).toHaveLength(0);
  });
});
