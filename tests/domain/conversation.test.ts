import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_MARKER,
  buildContextWindow,
  cleanInboundText,
  reactableMessages,
  DEFAULT_CONTEXT_WINDOW,
  endAtTrigger,
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

  test("keeps the root and then the most recent turns when over the window", () => {
    const history = Array.from({ length: 25 }, (_, i) => msg(i + 1, `m${i + 1}`));
    const out = buildContextWindow(history, 5);
    expect(out).toHaveLength(5);
    // the root stays: it is what the thread is about, and usually what was shared
    expect(out.map((m) => m.content)).toEqual(["m1", "m22", "m23", "m24", "m25"]);
    expect(out[0]?.content).toBe("m1");
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

describe("what survives a long thread", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => msg(i + 1, `turn ${i + 1}`));

  test("the root is kept - it is what the thread is about", () => {
    const out = buildContextWindow(many(30), 5);
    expect(out).toHaveLength(5);
    expect(out[0]?.content).toBe("turn 1"); // not dropped off the front
    expect(out[out.length - 1]?.content).toBe("turn 30"); // newest still last
  });

  test("a turn carrying an attachment survives, however old", () => {
    const history = many(30);
    history[1] = { ...history[1]!, content: `here is the screenshot\n${ATTACHMENT_MARKER}\n- shot.png (image/png)` };
    const out = buildContextWindow(history, 5);

    expect(out.some((m) => m.content.includes("shot.png"))).toBe(true);
    expect(out).toHaveLength(5);
    // still in order, oldest first, newest last
    expect(out[out.length - 1]?.content).toBe("turn 30");
  });

  test("several attachments all survive, and nothing is duplicated", () => {
    const history = many(30);
    for (const i of [1, 4, 9]) {
      history[i] = { ...history[i]!, content: `pic ${i}\n${ATTACHMENT_MARKER}\n- p${i}.png (image/png)` };
    }
    const out = buildContextWindow(history, 8);
    expect(out).toHaveLength(8);
    expect(new Set(out.map((m) => m.content)).size).toBe(8);
    for (const i of [1, 4, 9]) expect(out.some((m) => m.content.includes(`p${i}.png`))).toBe(true);
  });

  test("a thread full of screenshots still keeps the message being answered", () => {
    // the real case: 25 screenshot turns in a 100-turn thread, window 20 - the
    // attachments filled the window and the newest ask fell out
    const history = many(100);
    for (let i = 1; i < 60; i += 2) {
      history[i] = { ...history[i]!, content: `shot ${i}\n${ATTACHMENT_MARKER}\n- s${i}.png (image/png)` };
    }
    const out = buildContextWindow(history, 20);
    const contents = out.map((m) => m.content);

    expect(out).toHaveLength(20);
    expect(contents[0]).toBe("turn 1");
    expect(contents[contents.length - 1]).toBe("turn 100");
    // attachments get at most half, and the newest of them win
    const shots = contents.filter((c) => c.includes(ATTACHMENT_MARKER));
    expect(shots.length).toBeLessThanOrEqual(10);
    expect(contents.some((c) => c.includes("s59.png"))).toBe(true);
    expect(contents.some((c) => c.includes("s1.png"))).toBe(false);
    // and the rest is the recent conversation
    for (let n = 91; n <= 100; n++) expect(contents).toContain(`turn ${n}`);
  });

  test("a window of one keeps the newest turn, not the root", () => {
    expect(buildContextWindow(many(5), 1).map((m) => m.content)).toEqual(["turn 5"]);
  });

  test("a short thread is untouched", () => {
    const out = buildContextWindow(many(3), 20);
    expect(out.map((m) => m.content)).toEqual(["turn 1", "turn 2", "turn 3"]);
  });

  test("a window of zero keeps nothing", () => {
    expect(buildContextWindow(many(5), 0)).toEqual([]);
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

describe("endAtTrigger", () => {
  const at = (ts: string, content: string, role: "user" | "assistant" = "user") => ({ slackTs: ts, content, role });

  test("drops the busy notice and later asks posted after a queued message", () => {
    const thread = [
      at("1", "delete a"),
      at("2", "deleted that one", "assistant"),
      at("3", "delete b"),
      at("4", "⏳ still working on *delete a* (10s so far) - yours is next", "assistant"),
      at("5", "delete c"),
    ];
    const out = endAtTrigger(thread, "3");
    expect(out.map((t) => t.content)).toEqual(["delete a", "deleted that one", "delete b"]);
    expect(out[out.length - 1]?.role).toBe("user");
  });

  test("leaves the thread whole when the trigger is unknown or missing", () => {
    const thread = [at("1", "a"), at("2", "b")];
    expect(endAtTrigger(thread, "9")).toHaveLength(2);
    expect(endAtTrigger(thread)).toHaveLength(2);
  });
});
