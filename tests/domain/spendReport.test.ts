import { describe, expect, test } from "bun:test";
import { money, spendReport, tokens, windowLabel } from "../../src/domain/spendReport.ts";

const slice = (key: string, costUsd: number, runs = 1) => ({
  key,
  runs,
  costUsd,
  inputTokens: 0,
  outputTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
  durationMs: 0,
});

describe("spendReport", () => {
  test("an empty window says so rather than printing zeroes", () => {
    const out = spendReport(
      { runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, durationMs: 0 },
      [],
      [],
      86_400_000,
    );
    expect(out).toBe("nothing has run in the last 24h");
  });

  test("says list price every time, because nobody is invoiced it", () => {
    const out = spendReport(
      {
        runs: 3,
        costUsd: 12.5,
        inputTokens: 1200,
        outputTokens: 400,
        cacheRead: 2_000_000,
        cacheWrite: 10_000,
        durationMs: 3_600_000,
      },
      [slice("U1", 10, 2), slice("U2", 2.5)],
      [slice("review", 10, 2), slice("chat", 2.5)],
      86_400_000,
      new Map([["U1", "Kai"]]),
    );
    expect(out).toContain("list price");
    expect(out).toContain("$12.50");
    expect(out).toContain("Kai - $10.00");
    expect(out).toContain("<@U2>"); // no display name, so tag them
    expect(out).toContain("review - $10.00");
    expect(out).toContain("1h00 of model time");
    expect(out).toContain("2.0M cached");
  });

  test("a run nobody owns is shown, not dropped - the total must add up", () => {
    const out = spendReport(
      { runs: 1, costUsd: 1, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, durationMs: 0 },
      [slice("", 1)],
      [slice("chat", 1)],
      3_600_000,
    );
    expect(out).toContain("unattributed");
  });
});

describe("formatting", () => {
  test("tokens stay readable at every size", () => {
    expect(tokens(999)).toBe("999");
    expect(tokens(1_500)).toBe("2k");
    expect(tokens(2_400_000)).toBe("2.4M");
  });

  test("a tenth of a cent still reads as money", () => {
    expect(money(0.004)).toBe("$0.004");
    expect(money(4.5)).toBe("$4.50");
    expect(money(450)).toBe("$450");
  });

  test("the window is named the way someone would say it", () => {
    expect(windowLabel(3_600_000)).toBe("last 1h");
    expect(windowLabel(86_400_000)).toBe("last 24h");
    expect(windowLabel(7 * 86_400_000)).toBe("last 7 days");
  });
});
