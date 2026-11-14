import { describe, expect, test } from "bun:test";
import { createEmphasisNormalizer } from "../../src/infrastructure/slack/emphasis.ts";
import { toSlackMarkdown } from "../../src/domain/slackFormat.ts";

/** Feed `text` in slices of `size`, collecting every emission. */
const feed = (text: string, size: number): { out: string; emitted: string[] } => {
  const n = createEmphasisNormalizer();
  const emitted: string[] = [];
  for (let i = 0; i < text.length; i += size) emitted.push(n.push(text.slice(i, i + size)));
  emitted.push(n.flush());
  return { out: emitted.join(""), emitted };
};

const SAMPLES = [
  "*nhịp:* mở đầu, rồi *đậm* và _nghiêng_ và ~gạch~.",
  "* bullet one\n* bullet *two*\na * b and 2*3*4",
  "text `*code*` then *real* and `un*closed",
  "before\n```ts\nconst a = *p * 2*;\n```\n*after* the fence\n",
  "**already** *mixed* ~~done~~",
  "a *b\nnever closes\n*c* ok",
  "see <https://x.com/*a*|*label*> and *bold*",
];

describe("createEmphasisNormalizer", () => {
  for (const text of SAMPLES) {
    test(`same as the whole-text conversion at any slice size: ${JSON.stringify(text.slice(0, 24))}`, () => {
      for (let size = 1; size <= 13; size += 1) {
        const want = feed(text, text.length).out;
        expect(feed(text, size).out).toBe(want);
      }
    });
  }

  test("a pair split across deltas becomes bold", () => {
    const n = createEmphasisNormalizer();
    const out = n.push("hi *nh") + n.push("ip:* ok") + n.flush();
    expect(out).toBe("hi **nhip:** ok");
  });

  test("text before an open marker streams at once", () => {
    const n = createEmphasisNormalizer();
    expect(n.push("some words *start")).toBe("some words ");
    expect(n.push("ed* now")).toBe("**started** now");
  });

  test("matches toSlackMarkdown on prose with no code fence", () => {
    const text = "*a* and ~b~ and * c and *d*";
    expect(feed(text, 3).out).toBe(toSlackMarkdown(text));
  });

  test("code is never touched", () => {
    expect(feed("```\n*x*\n```\n", 1).out).toBe("```\n*x*\n```\n");
    expect(feed("`*x*`", 1).out).toBe("`*x*`");
  });

  test("an unclosed marker is released at flush", () => {
    expect(feed("a *b", 1).out).toBe("a *b");
  });
});
