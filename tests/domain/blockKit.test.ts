import { describe, expect, test } from "bun:test";
import {
  BLOCK_KIT_RULES,
  blockKitReply,
  createBlockKitExtractor,
  parseBlocks,
  parseKit,
  splitBlockKit,
  toBlockMessage,
  type Segment,
} from "../../src/domain/blockKit.ts";

const ALERT = '[{"type":"alert","level":"warning","text":{"type":"mrkdwn","text":"careful"}}]';

describe("parseBlocks", () => {
  test("takes an array, a single block, or {blocks}", () => {
    expect(parseBlocks(ALERT)?.[0]?.type).toBe("alert");
    expect(parseBlocks('{"type":"divider"}')).toEqual([{ type: "divider" }]);
    expect(parseBlocks('{"blocks":[{"type":"divider"}]}')).toEqual([{ type: "divider" }]);
  });

  test("refuses what is not Block Kit", () => {
    expect(parseBlocks("not json")).toBeUndefined();
    expect(parseBlocks("[]")).toBeUndefined();
    expect(parseBlocks('[{"text":"no type"}]')).toBeUndefined();
    expect(parseBlocks("[1,2]")).toBeUndefined();
  });

  test("caps at 50 blocks", () => {
    const many = JSON.stringify(Array.from({ length: 60 }, () => ({ type: "divider" })));
    expect(parseBlocks(many)).toHaveLength(50);
  });
});

describe("splitBlockKit", () => {
  test("lifts a blockkit fence out in order", () => {
    const segs = splitBlockKit(`before\n\`\`\`blockkit\n${ALERT}\n\`\`\`\nafter`);
    expect(segs.map((s) => s.kind)).toEqual(["text", "blocks", "text"]);
    expect(segs[0]).toEqual({ kind: "text", text: "before\n" });
    expect(segs[2]).toEqual({ kind: "text", text: "after" });
  });

  test("leaves ordinary code alone, even when it mentions blockkit", () => {
    const text = "```ts\nconst x = '```blockkit';\n```\nok";
    const segs = splitBlockKit("```ts\nconst a = 1;\n```\nok");
    expect(segs).toEqual([{ kind: "text", text: "```ts\nconst a = 1;\n```\nok" }]);
    expect(splitBlockKit(text).every((s) => s.kind === "text")).toBe(true);
  });

  test("a fence that does not parse is shown as code, not lost", () => {
    const segs = splitBlockKit("```blockkit\n{oops\n```\n");
    expect(segs).toEqual([{ kind: "text", text: "```json\n{oops\n```\n" }]);
  });

  test("an unterminated fence still shows its content", () => {
    const segs = splitBlockKit("x\n```blockkit\n[{\"type\":");
    expect(segs.map((s) => s.kind)).toEqual(["text"]);
    expect((segs[0] as { text: string }).text).toContain('[{"type":');
  });
});

describe("createBlockKitExtractor (streaming)", () => {
  test("gives the same result however the text is chopped", () => {
    const full = `hi there\n\`\`\`blockkit\n${ALERT}\n\`\`\`\nbye \`code\` and \`\`\`py\nprint(1)\n\`\`\`\n`;
    const whole = splitBlockKit(full);
    for (const size of [1, 2, 3, 7, 13]) {
      const x = createBlockKitExtractor();
      const out: Segment[] = [];
      for (let i = 0; i < full.length; i += size) out.push(...x.push(full.slice(i, i + size)));
      out.push(...x.flush());
      const merged: Segment[] = [];
      for (const s of out) {
        const last = merged[merged.length - 1];
        if (s.kind === "text" && last?.kind === "text") last.text += s.text;
        else merged.push(s.kind === "text" ? { ...s } : s);
      }
      expect(merged).toEqual(whole);
    }
  });

  test("streams prose immediately, holding only a possible fence", () => {
    const x = createBlockKitExtractor();
    expect(x.push("hello wor")).toEqual([{ kind: "text", text: "hello wor" }]);
    expect(x.push("ld ``")).toEqual([{ kind: "text", text: "ld " }]);
    expect(x.push("`blockkit\n[")).toEqual([]);
    expect(x.push('{"type":"divider"}]```')).toEqual([{ kind: "blocks", blocks: [{ type: "divider" }] }]);
  });
});

describe("toBlockMessage", () => {
  test("undefined when there are no blocks, so plain posts are unchanged", () => {
    expect(toBlockMessage("just text")).toBeUndefined();
  });

  test("wraps prose in markdown blocks and keeps it as the fallback", () => {
    const m = toBlockMessage(`**top**\n\`\`\`blockkit\n${ALERT}\n\`\`\`\nend`, (p) => p.toUpperCase());
    expect(m?.blocks.map((b) => b.type)).toEqual(["markdown", "alert", "markdown"]);
    expect(m?.blocks[0]).toEqual({ type: "markdown", text: "**top**" });
    expect(m?.text).toBe("**TOP**\n\nEND");
  });

  test("a blocks-only reply still has a non-empty fallback", () => {
    expect(toBlockMessage(`\`\`\`blockkit\n${ALERT}\n\`\`\``)?.text).toBe(" ");
  });

  test("a model fence brings no words of its own, so there is no plain stand-in", () => {
    expect(toBlockMessage(`hi\n\`\`\`blockkit\n${ALERT}\n\`\`\``)?.plain).toBeUndefined();
  });

  test("a fence with its own text: that text is the fallback, in place, and the plain stand-in", () => {
    const m = toBlockMessage(`before\n${blockKitReply("*cpu* fine", [{ type: "divider" }])}after`, (p) => `<${p}>`);
    expect(m?.blocks.map((b) => b.type)).toEqual(["markdown", "divider", "markdown"]);
    expect(m?.text).toBe("<before\n\n*cpu* fine\n\nafter>");
    expect(m?.plain).toBe(m?.text);
  });
});

describe("parseKit / blockKitReply", () => {
  test("{text, blocks} carries its fallback; an array has none", () => {
    expect(parseKit('{"text":"words","blocks":[{"type":"divider"}]}')).toEqual({ blocks: [{ type: "divider" }], fallback: "words" });
    expect(parseKit('[{"type":"divider"}]')).toEqual({ blocks: [{ type: "divider" }] });
    expect(parseKit('{"text":"  ","blocks":[{"type":"divider"}]}')).toEqual({ blocks: [{ type: "divider" }] });
  });

  test("round-trips, even when the content holds a fence of its own", () => {
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "task ```rm -rf``` title" } }];
    const reply = blockKitReply("a ```fence``` in the text", blocks);
    const segs = splitBlockKit(reply);
    expect(segs).toEqual([{ kind: "blocks", blocks, fallback: "a ```fence``` in the text" }]);
  });

  test("caps at 50 blocks", () => {
    const reply = blockKitReply("x", Array.from({ length: 60 }, () => ({ type: "divider" })));
    expect(toBlockMessage(reply)?.blocks).toHaveLength(50);
  });
});

test("the prompt teaches the fence tag", () => {
  expect(BLOCK_KIT_RULES).toContain("blockkit");
  expect(BLOCK_KIT_RULES).toContain("table");
});
