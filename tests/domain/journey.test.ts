import { describe, expect, test } from "bun:test";
import { cleanLine, journeyLine, parseFlags, parseId, parseProgress, sinceCutoff, tokenize, unwrapLink } from "../../src/domain/journey.ts";

describe("journey parsing", () => {
  test("tokenize keeps quoted phrases, smart quotes and --flag=value together", () => {
    expect(tokenize(`add Fix it --now "reading the log" --next=“then test” don't`)).toEqual([
      "add", "Fix", "it", "--now", "reading the log", "--next=then test", "don't",
    ]);
  });

  test("parseFlags separates words from flags and reports the first problem", () => {
    const f = parseFlags(tokenize(`1 shipped --progress 40 --pr <https://github.com/a/b/pull/2|PR> --note="a b"`));
    expect(f).toMatchObject({ words: ["1", "shipped"], progress: "40", note: "a b", prs: ["https://github.com/a/b/pull/2"] });
    expect(parseFlags(["--wat", "x"]).error).toContain("--wat");
    expect(parseFlags(["--now"]).error).toContain("needs a value");
  });

  test("progress, ids, spans and links", () => {
    expect(parseProgress("40%")).toBe(40);
    expect(parseProgress("0")).toBe(0);
    expect(parseProgress("101")).toBeUndefined();
    expect(parseProgress("x")).toBeUndefined();
    expect(parseId("#12")).toBe(12);
    expect(parseId("0")).toBeUndefined();
    expect(parseId(undefined)).toBeUndefined();
    expect(sinceCutoff("2d", 1_000_000_000)).toBe(1_000_000_000 - 2 * 86_400_000);
    expect(sinceCutoff("soon", 1)).toBeUndefined();
    expect(unwrapLink("<https://x.test/a|label>")).toBe("https://x.test/a");
    expect(cleanLine("  a \n b\t c ", 3)).toBe("a b");
  });

  test("a line shows progress and the now text only while it is moving", () => {
    const j = { id: 3, title: "T", status: "doing" as const, area: "Jarvis", progress: 40, now: "writing", updatedAt: 0 };
    expect(journeyLine(j, 3_600_000)).toBe("- #3 🔧 *T* [Jarvis] 40% - writing _1h00m ago_");
    expect(journeyLine({ ...j, status: "done" }, 30_000)).toBe("- #3 ✅ *T* [Jarvis] _just now_");
  });
});
