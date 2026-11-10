import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createCloudwatchRepo, type CloudwatchRepo } from "../../src/infrastructure/db/cloudwatchRepo.ts";
import type { CloudwatchRequest } from "../../src/domain/cloudwatch.ts";

const request: CloudwatchRequest = { groups: ["/ecs/be", "/ecs/be2"], region: "us-west-2", query: "fields @message | limit 5", startMs: 1000, endMs: 2000, limit: 50 };
const base = { requestedBy: "U1", requesterRole: "admin" as const, channelId: "C1", threadTs: "1.1", request, estimateBytes: 5, costly: false };
const TTL = 15 * 60_000;

let repo: CloudwatchRepo;
beforeEach(() => {
  repo = createCloudwatchRepo(openDatabase(":memory:"));
});

describe("cloudwatch_requests", () => {
  test("a confirm request is parked pending and round-trips whole", () => {
    const row = repo.open({ ...base, mode: "confirm" }, 100);
    expect(row).toMatchObject({ status: "pending", mode: "confirm", requestedBy: "U1", requesterRole: "admin", request, estimateBytes: 5, costly: false, confirmedBy: undefined });
    expect(repo.get(row.id)).toEqual(row);
  });

  test("an owner run is recorded already running, confirmed by themselves", () => {
    const row = repo.open({ ...base, requestedBy: "UOWNER", requesterRole: "owner", mode: "run" }, 100);
    expect(row).toMatchObject({ status: "running", mode: "run", confirmedBy: "UOWNER", decidedAt: 100 });
  });

  test("claim moves pending to running once, recording who confirmed", () => {
    const { id } = repo.open({ ...base, mode: "confirm" }, 100);
    expect(repo.claim(id, "U1", 200, TTL)).toBe(true);
    expect(repo.claim(id, "U2", 201, TTL)).toBe(false);
    expect(repo.get(id)).toMatchObject({ status: "running", confirmedBy: "U1", decidedAt: 200 });
  });

  test("a request older than the ttl cannot be claimed, and expires", () => {
    const { id } = repo.open({ ...base, mode: "confirm" }, 100);
    expect(repo.claim(id, "U1", 100 + TTL + 1, TTL)).toBe(false);
    expect(repo.expire(id, 100 + TTL + 1, TTL)).toBe(true);
    expect(repo.get(id)?.status).toBe("expired");
    // not before it is old enough
    const fresh = repo.open({ ...base, mode: "confirm" }, 1000);
    expect(repo.expire(fresh.id, 1001, TTL)).toBe(false);
  });

  test("cancel closes a pending request once and nothing can claim it after", () => {
    const { id } = repo.open({ ...base, mode: "confirm" }, 100);
    expect(repo.cancel(id, "U1", 150)).toBe(true);
    expect(repo.cancel(id, "U1", 151)).toBe(false);
    expect(repo.claim(id, "U1", 152, TTL)).toBe(false);
    expect(repo.get(id)?.status).toBe("cancelled");
  });

  test("finish records the scan or the failure", () => {
    const a = repo.open({ ...base, mode: "confirm" }, 100);
    repo.claim(a.id, "U1", 110, TTL);
    repo.finish(a.id, { ok: true, scannedBytes: 123, recordsMatched: 4 }, 120);
    expect(repo.get(a.id)).toMatchObject({ status: "done", scannedBytes: 123, recordsMatched: 4, finishedAt: 120 });
    const b = repo.open({ ...base, mode: "confirm" }, 100);
    repo.finish(b.id, { ok: false, error: "AccessDenied" }, 130);
    expect(repo.get(b.id)).toMatchObject({ status: "failed", error: "AccessDenied" });
  });

  test("notice and recent", () => {
    const a = repo.open({ ...base, mode: "confirm" }, 100);
    const b = repo.open({ ...base, mode: "confirm" }, 101);
    repo.setNotice(a.id, "C1", "9.9");
    expect(repo.get(a.id)).toMatchObject({ noticeChannel: "C1", noticeTs: "9.9" });
    expect(repo.recent(10).map((r) => r.id)).toEqual([b.id, a.id]);
  });

  test("failRunning closes rows a restart orphaned, and only those", () => {
    const a = repo.open({ ...base, mode: "confirm" }, 100);
    repo.claim(a.id, "U1", 110, TTL);
    const pending = repo.open({ ...base, mode: "confirm" }, 100);
    expect(repo.failRunning(200)).toBe(1);
    expect(repo.get(a.id)).toMatchObject({ status: "failed", error: "interrupted by a restart" });
    expect(repo.get(pending.id)?.status).toBe("pending");
  });
});
