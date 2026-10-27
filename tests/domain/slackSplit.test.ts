import { describe, expect, test } from "bun:test";
import { SECTION_LIMIT, splitForBlocks } from "../../src/domain/slackFormat.ts";

describe("splitForBlocks", () => {
  test("short text is one block", () => {
    expect(splitForBlocks("hello")).toEqual(["hello"]);
  });

  test("empty text is no block at all", () => {
    expect(splitForBlocks("")).toEqual([]);
    expect(splitForBlocks("   ")).toEqual([]);
  });

  test("long text is split, and every piece fits", () => {
    // Slack rejects a section over 3000 chars and takes the whole message with
    // it, so a command list that grows past the limit must not break help
    const text = Array.from({ length: 400 }, (_, i) => `- \`command${i}\` - does the ${i}th thing`).join("\n");
    const chunks = splitForBlocks(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= SECTION_LIMIT)).toBe(true);
  });

  test("it splits on line boundaries, losing nothing", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    const chunks = splitForBlocks(lines.join("\n"));

    expect(chunks.join("\n").split("\n")).toEqual(lines);
  });

  test("a single over-long line is passed through rather than cut", () => {
    // Slack's own truncation beats silently losing half of something
    const giant = "x".repeat(SECTION_LIMIT + 500);
    expect(splitForBlocks(giant)).toEqual([giant]);
  });
});
