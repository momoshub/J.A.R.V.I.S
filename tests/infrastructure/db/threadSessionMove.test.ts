import { expect, test } from "bun:test";
import { openDatabase } from "../../../src/infrastructure/db/client.ts";
import { migrate } from "../../../src/infrastructure/db/schema.ts";
import { createThreadSessionRepo } from "../../../src/infrastructure/db/threadSessionRepo.ts";

test("move rebinds every tier of a thread to the new key and leaves other threads alone", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const repo = createThreadSessionRepo(db);
  repo.claim("D1", "100.000007", "full", "sess-a", "100.000007", 1, "h");
  repo.claim("D1", "100.000007", "sandbox", "sess-b", "100.000007", 1, "h");
  repo.claim("D1", "200.5", "full", "other", "200.5", 1, "h");

  repo.move("D1", "100.000007", "D1", "300.1", "300.1");

  expect(repo.find("D1", "100.000007", "full")).toBeUndefined();
  expect(repo.find("D1", "300.1", "full")?.sessionId).toBe("sess-a");
  expect(repo.find("D1", "300.1", "full")?.lastTs).toBe("300.1");
  expect(repo.find("D1", "300.1", "sandbox")?.sessionId).toBe("sess-b");
  expect(repo.find("D1", "200.5", "full")?.sessionId).toBe("other");
});
