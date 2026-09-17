import { describe, expect, test } from "bun:test";
import { createFenceNormalizer } from "../../src/infrastructure/slack/fences.ts";

/** Stream `src` through the normaliser in fixed-size chunks, like a real delta feed. */
const stream = (src: string, chunk = src.length): string => {
  const n = createFenceNormalizer();
  let out = "";
  for (let i = 0; i < src.length; i += chunk) out += n.push(src.slice(i, i + chunk));
  return out + n.flush();
};

const CHUNKS = [1, 2, 5, 13, 1000];

describe("fence normaliser", () => {
  test("keeps a real language tag on the opening line", () => {
    for (const c of CHUNKS) {
      expect(stream("```ts\nconst a = 1;\n```\ndone", c)).toBe("```ts\nconst a = 1;\n```\ndone");
    }
  });

  test("demotes a non-language opening line to content", () => {
    for (const c of CHUNKS) {
      expect(stream("```// a comment\ncode\n```\n", c)).toBe("```\n// a comment\ncode\n```\n");
    }
  });

  test("breaks a closing fence off the end of a code line", () => {
    for (const c of CHUNKS) {
      expect(stream("```\n});```\nafter", c)).toBe("```\n});\n```\nafter");
    }
  });

  test("closes a block the model left open", () => {
    expect(stream("```\ncode here")).toBe("```\ncode here\n```\n");
  });

  test("leaves text without fences alone", () => {
    for (const c of CHUNKS) {
      expect(stream("plain `inline` text\nsecond line", c)).toBe("plain `inline` text\nsecond line");
    }
  });

  test("handles the real POST-to-GET message end to end", () => {
    const src = "look:\n\n```// Middleware\napp.use(() => {});```\n\nthen prose\n";
    const want = "look:\n\n```\n// Middleware\napp.use(() => {});\n```\n\nthen prose\n";
    for (const c of CHUNKS) expect(stream(src, c)).toBe(want);
  });
});
