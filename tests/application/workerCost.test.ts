import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createWorkerUsageRepo, type WorkerUsageRepo } from "../../src/infrastructure/db/workerUsageRepo.ts";
import { workerCostReport, type WorkerUsagePort } from "../../src/application/workerCost.ts";
import { workerUsage, type ModelUsage, type WorkerUsage } from "../../src/domain/workerUsage.ts";

const m = (model: string, output: number): ModelUsage => ({ model, messages: 1, input: 0, output, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
const w = (id: string, output: number, runId = "run_1"): WorkerUsage => ({ ...workerUsage(id, `s-${id}`, [m("claude-haiku-4-5", output)]), runId });

let repo: WorkerUsageRepo;
beforeEach(() => {
  repo = createWorkerUsageRepo(openDatabase(":memory:"));
});

const port = (live: Record<string, WorkerUsage>, runs: Record<string, string[]> = {}): WorkerUsagePort => ({
  measure: async (id) => live[id] ?? { error: "Orca has forgotten it" },
  dispatchesOf: async (run) => runs[run] ?? [],
  repo,
});

describe("workerUsageRepo", () => {
  test("stores, replaces, and lists a Run", () => {
    repo.save(w("ctx_a", 100), 1);
    repo.save(w("ctx_a", 1_000_000), 2);
    repo.save(w("ctx_b", 5, "run_2"), 3);
    expect(repo.get("ctx_a")).toMatchObject({ sessionId: "s-ctx_a", runId: "run_1", measuredAt: 2 });
    expect(repo.get("ctx_a")!.costUsd).toBeCloseTo(5, 6);
    expect(repo.inRun("run_1").map((u) => u.dispatchId)).toEqual(["ctx_a"]);
    expect(repo.get("ctx_x")).toBeUndefined();
  });
});

describe("workerCostReport", () => {
  test("a live worker is reported and stored", async () => {
    const out = await workerCostReport("ctx_a", port({ ctx_a: w("ctx_a", 1_000_000) }), 10);
    expect(out).toContain("Orca worker ctx_a used");
    expect(out).toContain("$5.00 at list price");
    expect(out).toContain("session s-ctx_a");
    expect(repo.get("ctx_a")?.measuredAt).toBe(10);
  });

  test("a worker Orca forgot answers from what was stored, and says when", async () => {
    repo.save(w("ctx_a", 1_000_000), 0);
    const out = await workerCostReport("ctx_a", port({}), 3 * 60 * 60_000);
    expect(out).toContain("$5.00");
    expect(out).toContain("measured 3h ago; Orca has forgotten it");
  });

  test("unknown worker and bad target", async () => {
    expect(await workerCostReport("ctx_zz", port({}), 0)).toContain("I cannot tell what ctx_zz used: Orca has forgotten it");
    expect(await workerCostReport("hello", port({}), 0)).toContain("dispatch id");
  });

  test("a Run totals its workers, including stored ones Orca no longer lists", async () => {
    repo.save(w("ctx_old", 1_000_000), 0);
    const out = await workerCostReport(
      "run_1",
      port({ ctx_a: w("ctx_a", 1_000_000), ctx_b: w("ctx_b", 2_000_000) }, { run_1: ["ctx_a", "ctx_b", "ctx_gone"] }),
      1,
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("Run run_1, 4 workers: $20.00 at list price in all");
    expect(out).toContain("- ctx_gone: could not tell");
    expect(out).toContain("- ctx_old:");
    expect(await workerCostReport("run_9", port({}), 0)).toBe("I know of no workers in run_9.");
  });
});
