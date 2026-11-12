import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../../src/infrastructure/db/schema.ts";
import { createWorkerTicketRepo } from "../../../src/infrastructure/db/workerTicketRepo.ts";

const HOUR = 60 * 60_000;

describe("worker_tickets bound_at (migration v32)", () => {
  test("a bound ticket from before the column gets its bind time back from expires_at - ttl_ms; a pending one stays 0", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE worker_tickets (
        token_hash TEXT PRIMARY KEY, id TEXT NOT NULL, actor TEXT NOT NULL, channel TEXT NOT NULL,
        thread_ts TEXT NOT NULL DEFAULT '', repo TEXT NOT NULL, actions TEXT NOT NULL, ttl_ms INTEGER NOT NULL,
        dispatch_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
      );
      INSERT INTO worker_tickets (token_hash, id, actor, channel, repo, actions, ttl_ms, dispatch_id, created_at, expires_at)
        VALUES ('h1', 'aaaaaaaa', 'U1', 'C1', 'o/r', '[]', ${3 * HOUR}, 'ctx_w1', 500, ${10_000 + 3 * HOUR}),
               ('h2', 'bbbbbbbb', 'U1', 'C1', 'o/r', '[]', ${3 * HOUR}, '', 600, 1000);
    `);
    migrate(db);
    migrate(db); // idempotent
    const repo = createWorkerTicketRepo(db);
    expect(repo.byId("aaaaaaaa")?.boundAt).toBe(10_000);
    expect(repo.byId("bbbbbbbb")?.boundAt).toBe(0);
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBeGreaterThanOrEqual(32);
  });

  test("bind stores the bind time and setExpiry moves only the expiry", () => {
    const db = new Database(":memory:");
    migrate(db);
    const repo = createWorkerTicketRepo(db);
    repo.insert({ tokenHash: "h", id: "cccccccc", actor: "U1", channel: "C1", threadTs: "", repo: "o/r", actions: [], ttlMs: HOUR, dispatchId: "", createdAt: 1, boundAt: 0, expiresAt: 2 });
    repo.bind("h", "ctx_w1", 100, 100 + HOUR);
    repo.setExpiry("h", 100 + 5 * HOUR);
    expect(repo.byId("cccccccc")).toMatchObject({ dispatchId: "ctx_w1", boundAt: 100, expiresAt: 100 + 5 * HOUR });
  });
});
