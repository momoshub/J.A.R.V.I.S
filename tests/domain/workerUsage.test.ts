import { describe, expect, test } from "bun:test";
import {
  MODEL_PRICES,
  parseWorkerUsageLine,
  priceKey,
  priceOf,
  projectSlug,
  shortCount,
  sumTranscripts,
  usageSummary,
  workerUsage,
  workerUsageLine,
  type ModelUsage,
} from "../../src/domain/workerUsage.ts";

type Usage = Record<string, unknown>;

const line = (o: { id?: string; requestId?: string; uuid?: string; model?: string; usage?: Usage; type?: string }): string =>
  JSON.stringify({
    type: o.type ?? "assistant",
    uuid: o.uuid ?? crypto.randomUUID(),
    ...(o.requestId ? { requestId: o.requestId } : {}),
    message: {
      ...(o.id ? { id: o.id } : {}),
      model: o.model ?? "claude-opus-5-5",
      role: "assistant",
      ...(o.usage ? { usage: o.usage } : {}),
    },
  });

const u = (input: number, output: number, write = 0, read = 0): Usage => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
});

const zero: Omit<ModelUsage, "model"> = { messages: 1, input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };

describe("sumTranscripts", () => {
  test("a message written once per content block is counted once", () => {
    const text = [line({ id: "msg_1", usage: u(10, 100) }), line({ id: "msg_1", usage: u(10, 100) }), line({ id: "msg_2", usage: u(5, 50) })].join("\n");
    const [m] = sumTranscripts([text]);
    expect(m).toMatchObject({ model: "claude-opus-5-5", messages: 2, input: 15, output: 150 });
  });

  test("duplicates keep the largest value of each field", () => {
    const text = [line({ id: "msg_1", usage: u(10, 3) }), line({ id: "msg_1", usage: u(10, 90) })].join("\n");
    expect(sumTranscripts([text])[0]).toMatchObject({ input: 10, output: 90 });
  });

  test("falls back to requestId, then uuid, to tell messages apart", () => {
    const text = [
      line({ requestId: "req_1", usage: u(1, 1) }),
      line({ requestId: "req_1", usage: u(1, 1) }),
      line({ uuid: "a", usage: u(2, 2) }),
      line({ uuid: "b", usage: u(2, 2) }),
    ].join("\n");
    expect(sumTranscripts([text])[0]).toMatchObject({ messages: 3, input: 5 });
  });

  test("the same message in two files counts once", () => {
    const a = line({ id: "msg_1", usage: u(10, 10) });
    expect(sumTranscripts([a, a])[0]!.messages).toBe(1);
  });

  test("missing fields, junk lines, non-assistant and synthetic lines are skipped", () => {
    const text = [
      "not json",
      "",
      JSON.stringify({ type: "user", message: { usage: u(99, 99) } }),
      line({ id: "msg_s", model: "<synthetic>", usage: u(99, 99) }),
      line({ id: "msg_n" }),
      line({ id: "msg_1", usage: { output_tokens: 7 } }),
    ].join("\n");
    const out = sumTranscripts([text]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ messages: 1, input: 0, output: 7, cacheWrite5m: 0, cacheRead: 0 });
  });

  test("cache writes are split by TTL when the transcript says so", () => {
    const usage = { ...u(1, 1, 300, 1000), cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } };
    expect(sumTranscripts([line({ id: "m", usage })])[0]).toMatchObject({ cacheWrite5m: 100, cacheWrite1h: 200, cacheRead: 1000 });
    // no split: all of it at the 5-minute price
    expect(sumTranscripts([line({ id: "m", usage: u(1, 1, 300) })])[0]).toMatchObject({ cacheWrite5m: 300, cacheWrite1h: 0 });
  });

  test("several models are kept apart, the dearest first", () => {
    const text = [
      line({ id: "a", model: "claude-haiku-4-5", usage: u(1000, 1000) }),
      line({ id: "b", model: "claude-opus-5-5", usage: u(1000, 1000) }),
      line({ id: "c", model: "claude-opus-5-5", usage: { ...u(10, 10), speed: "fast" } }),
    ].join("\n");
    expect(sumTranscripts([text]).map((m) => m.model)).toEqual(["claude-opus-5-5", "claude-haiku-4-5", "claude-opus-5-5 (fast)"]);
  });
});

describe("pricing", () => {
  test("model ids resolve by longest prefix, ignoring dates and [1m]", () => {
    expect(priceKey("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(priceKey("claude-opus-5")).toBe("claude-opus-5");
    expect(priceKey("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(priceKey("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(priceKey("claude-sonnet-5-5 (fast)")).toBe("claude-sonnet-5-5");
    expect(priceKey("gpt-5")).toBeUndefined();
  });

  test("input, output, both cache writes and cache reads are priced separately", () => {
    // Opus 5.5: $4 in, $20 out, $0.20 read; writes 1.25x / 2x input.
    const m = { ...zero, model: "claude-opus-5-5", input: 1_000_000, output: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000, cacheRead: 1_000_000 };
    expect(priceOf(m)).toBeCloseTo(4 + 20 + 5 + 8 + 0.2, 6);
  });

  test("fast mode costs its multiple; an unknown model has no price", () => {
    const base = { ...zero, model: "claude-opus-5-5", output: 1_000_000 };
    expect(priceOf({ ...base, model: "claude-opus-5-5 (fast)" })).toBeCloseTo(2 * priceOf(base)!, 6);
    expect(priceOf({ ...base, model: "mystery-1" })).toBeUndefined();
  });

  test("every price reads 0.025x-0.1x input for cache reads", () => {
    for (const p of Object.values(MODEL_PRICES)) {
      expect(p.cacheRead).toBeGreaterThanOrEqual(p.input * 0.025 - 1e-9);
      expect(p.cacheRead).toBeLessThanOrEqual(p.input * 0.1 + 1e-9);
    }
  });

  test("workerUsage leaves unpriced models out of the cost and names them", () => {
    const w = workerUsage("ctx_a", "s", [
      { ...zero, model: "claude-haiku-4-5", output: 1_000_000 },
      { ...zero, model: "mystery-1", output: 1_000_000 },
    ]);
    expect(w.costUsd).toBeCloseTo(5, 6);
    expect(w.unpriced).toEqual(["mystery-1"]);
    expect(usageSummary(w)).toContain("not counting mystery-1");
    expect(workerUsage("ctx_a", "s", [{ ...zero, model: "mystery-1" }]).costUsd).toBeUndefined();
  });
});

describe("usage line", () => {
  test("round-trips and is recognised among other output", () => {
    const w = { ...workerUsage("ctx_ab12", "sess-1", [{ ...zero, model: "claude-opus-5-5", input: 5, output: 7 }]), runId: "run_9", startedAt: 42 };
    const out = `orca worker ctx_ab12 finished: outcome succeeded\n${workerUsageLine(w)}`;
    const back = parseWorkerUsageLine(out)!;
    expect(back).toMatchObject({ dispatchId: "ctx_ab12", sessionId: "sess-1", runId: "run_9", startedAt: 42 });
    expect(back.models[0]).toMatchObject({ input: 5, output: 7 });
    expect(back.costUsd).toBeCloseTo(w.costUsd!, 9);
    expect(parseWorkerUsageLine("orca worker ctx_ab12 usage {broken")).toBeUndefined();
    expect(parseWorkerUsageLine("nothing here")).toBeUndefined();
  });

  test("summary and counts read short", () => {
    expect(shortCount(950)).toBe("950");
    expect(shortCount(1234)).toBe("1.2k");
    expect(shortCount(3_400_000)).toBe("3.40M");
    expect(usageSummary(workerUsage("c", "s", []))).toBe("no billed messages in its transcript");
    const s = usageSummary(workerUsage("c", "s", [{ ...zero, model: "claude-opus-5-5", input: 1000, output: 2000, cacheRead: 1_000_000 }]));
    expect(s).toContain("1.00M tokens");
    expect(s).toContain("at list price, claude-opus-5-5");
  });

  test("project slug matches Claude Code's folder names", () => {
    expect(projectSlug("/Users/kai/Workspaces/J.A.R.V.I.S.")).toBe("-Users-kai-Workspaces-J-A-R-V-I-S-");
  });
});
