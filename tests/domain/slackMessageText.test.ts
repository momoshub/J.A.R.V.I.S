import { describe, expect, test } from "bun:test";
import { taskCardTitles, visibleText } from "../../src/domain/slackMessageText.ts";

describe("visibleText", () => {
  test("a plain message is untouched", () => {
    expect(visibleText({ text: "hello there" })).toBe("hello there");
  });

  test("a streamed reply loses the tool calls Slack flattened into it", () => {
    // the real shape: thinking card, one Bash card, then the answer
    const msg = {
      text: "🐦‍🔥 run: cd /repo && sqlite3 data/bot.db .tables Nói thật thì em gần như không dùng lib nào",
      blocks: [
        { type: "task_card", title: "🐦‍🔥" },
        { type: "task_card", title: "run: cd /repo && sqlite3 data/bot.db .tables" },
        { type: "rich_text" },
      ],
    };
    expect(visibleText(msg)).toBe("Nói thật thì em gần như không dùng lib nào");
  });

  test("a card in the MIDDLE is cut out of the middle", () => {
    const msg = {
      text: "first I looked run: ls second here is what I found",
      blocks: [
        { type: "rich_text" },
        { type: "task_card", title: "run: ls" },
        { type: "rich_text" },
      ],
    };
    expect(visibleText(msg)).toBe("first I looked second here is what I found");
  });

  test("a message that was nothing but tool cards said nothing", () => {
    const msg = {
      text: "🐦‍🔥 run: ls",
      blocks: [
        { type: "task_card", title: "🐦‍🔥" },
        { type: "task_card", title: "run: ls" },
      ],
    };
    expect(visibleText(msg)).toBe("");
  });

  test("text that happens to repeat a card title keeps its own copy", () => {
    // only the first occurrence at or after the previous cut is removed, which
    // is how the fallback was assembled in the first place
    const msg = {
      text: "run: ls I ran run: ls for you",
      blocks: [{ type: "task_card", title: "run: ls" }, { type: "rich_text" }],
    };
    expect(visibleText(msg)).toBe("I ran run: ls for you");
  });

  test("a title that is not in the fallback leaves the text alone", () => {
    const msg = {
      text: "the answer",
      blocks: [{ type: "task_card", title: "run: something clipped" }],
    };
    expect(visibleText(msg)).toBe("the answer");
  });

  test("titles come back in block order", () => {
    expect(
      taskCardTitles([
        { type: "rich_text" },
        { type: "task_card", title: "b" },
        { type: "task_card", title: " a " },
      ]),
    ).toEqual(["b", "a"]);
  });
});
