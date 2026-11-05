import { describe, expect, test } from "bun:test";
import { compactTokens, minSec, usageFooter, usageFooterBlock } from "../../src/domain/usageFooter.ts";

const USAGE = {
  model: "claude-opus-5-5",
  inputTokens: 95_900,
  outputTokens: 10_600,
  cacheReadTokens: 1_600_000,
  cacheWriteTokens: 20_400,
  costUsd: 1.3031,
  durationMs: 196_000,
};

describe("usage footer", () => {
  test("one line: model, in, out, cache, cost, minutes and seconds", () => {
    expect(usageFooter(USAGE)).toBe("claude-opus-5-5 · in 95.9k · out 10.6k · cache 1.62M · $1.30 · 3m 16s");
  });

  test("time is always minutes and seconds, even under a minute", () => {
    expect(minSec(42_000)).toBe("0m 42s");
    expect(minSec(60_000)).toBe("1m 0s");
  });

  test("tokens are compacted without trailing zeros", () => {
    expect(compactTokens(950)).toBe("950");
    expect(compactTokens(12_000)).toBe("12k");
    expect(compactTokens(2_000_000)).toBe("2M");
  });

  test("a run with no model name still renders", () => {
    expect(usageFooter({ ...USAGE, model: "" })).toStartWith("unknown model · ");
  });

  test("renders as a Slack context block", () => {
    expect(usageFooterBlock(USAGE)).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: usageFooter(USAGE) }],
    });
  });
});
