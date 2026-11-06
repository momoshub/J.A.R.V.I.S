import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createFollowRepo } from "../../src/infrastructure/db/followRepo.ts";

describe("follow repo", () => {
  test("a one-on-one starts following on its own", () => {
    const follows = createFollowRepo(openDatabase(":memory:"));
    expect(follows.autoAdd("C1", "1.0", "U1", 1)).toBe(true);
    expect(follows.isFollowed("C1", "1.0")).toBe(true);
    // already following: nothing new
    expect(follows.autoAdd("C1", "1.0", "U1", 2)).toBe(false);
  });

  test("an off sticks: a later one-on-one does not turn it back on", () => {
    const db = openDatabase(":memory:");
    const follows = createFollowRepo(db);
    follows.autoAdd("C1", "1.0", "U1", 1);
    expect(follows.remove("C1", "1.0", 2)).toBe(true);
    expect(follows.isFollowed("C1", "1.0")).toBe(false);
    expect(follows.isOptedOut("C1", "1.0")).toBe(true);
    expect(follows.autoAdd("C1", "1.0", "U1", 3)).toBe(false);
    // and it survives a restart
    expect(createFollowRepo(db).isOptedOut("C1", "1.0")).toBe(true);
  });

  test("asking to follow again lifts the off", () => {
    const db = openDatabase(":memory:");
    const follows = createFollowRepo(db);
    follows.remove("C1", "1.0", 1);
    follows.add("C1", "1.0", "U1", 2);
    expect(follows.isFollowed("C1", "1.0")).toBe(true);
    expect(follows.isOptedOut("C1", "1.0")).toBe(false);
    expect(createFollowRepo(db).isOptedOut("C1", "1.0")).toBe(false);
  });
});
