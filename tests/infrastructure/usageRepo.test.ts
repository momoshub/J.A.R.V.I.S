import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createUsageRepo, type UsageEntry, type UsageRepo } from "../../src/infrastructure/db/usageRepo.ts";

const run = (over: Partial<UsageEntry> = {}): UsageEntry => ({
  slackUserId: "U1",
  kind: "chat",
  channelId: "C1",
  model: "claude-opus-5-5",
  payer: "bot",
  inputTokens: 10,
  outputTokens: 100,
  cacheRead: 1000,
  cacheWrite: 500,
  costUsd: 0.25,
  durationMs: 2000,
  ...over,
});

let db: DbClient;
let usage: UsageRepo;

beforeEach(() => {
  db = openDatabase(":memory:");
  usage = createUsageRepo(db);
});

describe("usageRepo", () => {
  test("an empty table totals to zero rather than nothing", () => {
    expect(usage.totals(0)).toEqual({
      runs: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      durationMs: 0,
    });
  });

  test("totals add up over the window, and only over the window", () => {
    usage.add(run(), 1_000);
    usage.add(run({ costUsd: 0.75 }), 2_000);
    usage.add(run({ costUsd: 9 }), 100); // before the window

    const t = usage.totals(1_000);
    expect(t.runs).toBe(2);
    expect(t.costUsd).toBeCloseTo(1, 6);
    expect(t.outputTokens).toBe(200);
  });

  test("per person, dearest first", () => {
    usage.add(run({ slackUserId: "U1", costUsd: 1 }), 10);
    usage.add(run({ slackUserId: "U2", costUsd: 3 }), 10);
    usage.add(run({ slackUserId: "U2", costUsd: 1 }), 10);

    const rows = usage.byUser(0);
    expect(rows.map((r) => r.key)).toEqual(["U2", "U1"]);
    expect(rows[0]?.runs).toBe(2);
    expect(rows[0]?.costUsd).toBeCloseTo(4, 6);
  });

  test("per command, with chat and workflow counted like any other kind", () => {
    usage.add(run({ kind: "review", costUsd: 5 }), 10);
    usage.add(run({ kind: "chat", costUsd: 2 }), 10);
    usage.add(run({ kind: "workflow", costUsd: 1 }), 10);

    expect(usage.byKind(0).map((r) => r.key)).toEqual(["review", "chat", "workflow"]);
  });

  test("a run nobody can be attributed to is still recorded", () => {
    usage.add(run({ slackUserId: "" }), 10);
    expect(usage.count()).toBe(1);
    expect(usage.byUser(0)[0]?.key).toBe("");
  });
});
