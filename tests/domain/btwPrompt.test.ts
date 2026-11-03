import { describe, expect, test } from "bun:test";
import { btwRules } from "../../src/domain/btwPrompt.ts";

describe("btwRules", () => {
  test("says the tools are gone and forbids pretending otherwise", () => {
    const r = btwRules();
    expect(r).toContain("NO TOOLS");
    expect(r).toContain("never describe a command's output as though you had run it");
  });

  test("says the context is read-only and the work is not its to continue", () => {
    const r = btwRules();
    expect(r).toContain("context only");
    expect(r).toContain("not continuing it");
  });

  test("asks for an aside, not a turn", () => {
    expect(btwRules()).toContain("SHORT");
  });
});
