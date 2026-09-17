import { describe, expect, test } from "bun:test";
import { createFenceNormalizer } from "../../src/infrastructure/slack/fences.ts";

/** Feed the text one character at a time - the worst case a stream can hand us. */
const drip = (text: string): string => {
  const n = createFenceNormalizer();
  let out = "";
  for (const ch of text) out += n.push(ch);
  return out + n.flush();
};

const whole = (text: string): string => {
  const n = createFenceNormalizer();
  return n.push(text) + n.flush();
};

const both = (text: string): [string, string] => [whole(text), drip(text)];

describe("createFenceNormalizer", () => {
  test("leaves well-formed fences alone", () => {
    const src = "look:\n```ts\nconst a = 1;\n```\ndone\n";
    expect(both(src)).toEqual([src, src]);
  });

  test("leaves plain text and inline code alone", () => {
    const src = "use `bun test` to run it";
    expect(both(src)).toEqual([src, src]);
  });

  test("demotes a non-language opening tag to a content line", () => {
    const src = "```// Middleware to handle GET\napp.use(x);\n```\nafter";
    const want = "```\n// Middleware to handle GET\napp.use(x);\n```\nafter";
    expect(both(src)).toEqual([want, want]);
  });

  test("moves a closing fence off the end of a code line", () => {
    const src = "```js\n});```\nexplanation";
    const want = "```js\n});\n```\nexplanation";
    expect(both(src)).toEqual([want, want]);
  });

  test("handles the real-world case: bad open and bad close together", () => {
    const src = "```// note\nrouter.use(m);\n});```\nthat is the fix";
    const want = "```\n// note\nrouter.use(m);\n});\n```\nthat is the fix";
    expect(both(src)).toEqual([want, want]);
  });

  test("moves an opening fence off the end of a prose line", () => {
    const src = "here it is: ```ts\nconst a = 1;\n```\n";
    const want = "here it is: \n```ts\nconst a = 1;\n```\n";
    expect(both(src)).toEqual([want, want]);
  });

  test("closes a block the model never closed", () => {
    const src = "```ts\nconst a = 1;";
    const want = "```ts\nconst a = 1;\n```\n";
    expect(both(src)).toEqual([want, want]);
  });

  test("keeps a bare fence with no language", () => {
    const src = "```\nplain\n```\n";
    expect(both(src)).toEqual([src, src]);
  });

  test("holds back a partial fence marker instead of leaking it", () => {
    const n = createFenceNormalizer();
    expect(n.push("done ``")).toBe("done ");
    expect(n.push("`ts\nx\n```\n")).toBe("done \n```ts\nx\n```\n".slice("done ".length));
  });

  test("survives two blocks in one message", () => {
    const src = "```py\na\n```\nmid\n```sh\nb\n```\nend";
    expect(both(src)).toEqual([src, src]);
  });
});
