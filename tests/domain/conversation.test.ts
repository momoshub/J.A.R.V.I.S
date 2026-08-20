import { describe, expect, test } from "bun:test";
import {
  buildContextWindow,
  cleanInboundText,
  DEFAULT_CONTEXT_WINDOW,
} from "../../src/domain/conversation.ts";
import type { StoredMessage } from "../../src/domain/types.ts";

const msg = (id: number, content: string): StoredMessage => ({
  id,
  channelId: "C1",
  slackUserId: "U1",
  role: id % 2 === 0 ? "assistant" : "user",
  content,
  createdAt: id,
});

describe("buildContextWindow", () => {
  test("keeps role, content and the speaker id", () => {
    const out = buildContextWindow([msg(1, "hi")]);
    expect(out).toEqual([{ role: "user", content: "hi", speakerId: "U1" }]);
  });

  test("keeps the most recent turns when over the window", () => {
    const history = Array.from({ length: 25 }, (_, i) => msg(i + 1, `m${i + 1}`));
    const out = buildContextWindow(history, 5);
    expect(out).toHaveLength(5);
    expect(out[0]?.content).toBe("m21");
    expect(out[4]?.content).toBe("m25");
  });

  test("defaults to DEFAULT_CONTEXT_WINDOW", () => {
    const history = Array.from({ length: 50 }, (_, i) => msg(i + 1, `m${i}`));
    expect(buildContextWindow(history)).toHaveLength(DEFAULT_CONTEXT_WINDOW);
  });

  test("handles empty history", () => {
    expect(buildContextWindow([])).toEqual([]);
  });
});

describe("cleanInboundText", () => {
  test("collapses whitespace and trims", () => {
    expect(cleanInboundText("a   b\n\nc")).toBe("a b c");
    expect(cleanInboundText("  hi  ")).toBe("hi");
  });

  test("keeps mentions (annotated upstream) so the model sees who is referenced", () => {
    expect(cleanInboundText("<@U123:Kai> hello there")).toBe("<@U123:Kai> hello there");
  });
});
