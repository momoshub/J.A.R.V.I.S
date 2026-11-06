import { describe, expect, test } from "bun:test";
import { createDraftReply } from "../../src/application/draftReply.ts";
import type { LlmCompleteParams } from "../../src/application/ports.ts";

const setup = () => {
  const calls: LlmCompleteParams[] = [];
  const draft = createDraftReply({
    llm: { complete: async (p) => (calls.push(p), " hello ") },
    promptContext: () => ({ learnings: [] }),
    ownerSlackId: "UOWNER",
  });
  return { calls, draft };
};

describe("draftReply", () => {
  test("bills the draft to the owner as its own kind, so it is never unattributed", async () => {
    const { calls, draft } = setup();
    expect(await draft([], "C123")).toBe("hello");
    expect(calls[0]?.bill).toEqual({ actor: "UOWNER", kind: "draft", channel: "C123" });
  });

  test("leaves the channel out when none is given", async () => {
    const { calls, draft } = setup();
    await draft([]);
    expect(calls[0]?.bill).toEqual({ actor: "UOWNER", kind: "draft" });
  });
});
