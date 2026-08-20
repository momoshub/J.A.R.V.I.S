import { describe, expect, test } from "bun:test";
import {
  buildContextWindow,
  cleanInboundText,
  reactableMessages,
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

describe("reactableMessages", () => {
  const msg = (over: Partial<StoredMessage> = {}): StoredMessage => ({
    id: 1,
    channelId: "C1",
    slackUserId: "U1",
    role: "user",
    content: "hello",
    createdAt: 0,
    ...over,
  });

  test("offers human turns that carry a Slack ts, newest last", () => {
    const out = reactableMessages([
      msg({ id: 1, slackTs: "1.1", content: "first" }),
      msg({ id: 2, slackTs: "2.2", content: "second", slackUserId: "U2" }),
    ]);
    expect(out).toEqual([
      { ts: "1.1", speakerId: "U1", excerpt: "first" },
      { ts: "2.2", speakerId: "U2", excerpt: "second" },
    ]);
  });

  test("skips the bot's own turns and anything stored without a ts", () => {
    const out = reactableMessages([
      msg({ id: 1, content: "no ts here" }),
      msg({ id: 2, role: "assistant", slackTs: "2.2", content: "my own reply" }),
      msg({ id: 3, slackTs: "3.3", content: "reactable" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.ts).toBe("3.3");
  });

  test("keeps only the most recent few, and clips long excerpts", () => {
    const many = Array.from({ length: 12 }, (_, i) => msg({ id: i, slackTs: `${i}.0`, content: `m${i}` }));
    const out = reactableMessages(many, 3);
    expect(out.map((r) => r.ts)).toEqual(["9.0", "10.0", "11.0"]);

    const [long] = reactableMessages([msg({ slackTs: "1.1", content: "x".repeat(200) })]);
    expect(long?.excerpt).toHaveLength(83); // 80 + the ellipsis
    expect(long?.excerpt.endsWith("...")).toBe(true);
  });
});
