import { describe, expect, test } from "bun:test";
import {
  BLOCK_KIT_RULES,
  blockKitReply,
  blocksToText,
  createBlockKitExtractor,
  normalizeBlocks,
  parseBlocks,
  parseKit,
  splitBlockKit,
  readableText,
  toBlockMessage,
  type Segment,
} from "../../src/domain/blockKit.ts";

const TABLE_WITH_EMPTY_CELL = JSON.stringify([
  {
    type: "table",
    rows: [
      [
        { type: "raw_text", text: "Name" },
        { type: "raw_text", text: "Qty" },
      ],
      [
        { type: "raw_text", text: "widget" },
        { type: "raw_text", text: "" },
      ],
    ],
  },
]);

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

  test("a model fence brings no words of its own, so its blocks are rendered as the plain stand-in", () => {
    const m = toBlockMessage(`hi\n\`\`\`blockkit\n${ALERT}\n\`\`\``);
    expect(m?.plain).toBe("hi\n\ncareful");
    expect(m?.text).toBe("hi");
  });

  test("the plain stand-in never carries the raw fence, whatever the blocks are", () => {
    const m = toBlockMessage(`intro\n\`\`\`blockkit\n${TABLE_WITH_EMPTY_CELL}\n\`\`\`\noutro`);
    expect(m?.plain).toBe("intro\n\nName | Qty\nwidget | -\n\noutro");
    expect(m?.plain).not.toContain("blockkit");
    expect(readableText(`\`\`\`blockkit\n${TABLE_WITH_EMPTY_CELL}\n\`\`\``)).toBe("Name | Qty\nwidget | -");
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

describe("normalizeBlocks (Slack's min-length traps)", () => {
  const table = (...cells: string[]) => ({ type: "table", rows: [cells.map((text) => ({ type: "raw_text", text }))] });

  test("an empty or whitespace table cell becomes a dash, header included", () => {
    expect(parseBlocks(JSON.stringify([table("", "  ", "ok")]))).toEqual([table("-", "-", "ok")]);
  });

  test("a cell that has text, and one that is not raw_text, are left alone", () => {
    const rich = { type: "rich_text", elements: [] };
    const t = { type: "table", rows: [[{ type: "raw_text", text: "x" }, rich]] };
    expect(normalizeBlocks([t])).toEqual([t]);
  });

  test("a header, markdown or section with no text is dropped; the rest stay in order", () => {
    const blocks = [
      { type: "header", text: { type: "plain_text", text: " " } },
      { type: "markdown", text: "" },
      { type: "section", text: { type: "mrkdwn", text: "" } },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: "kept" } },
    ];
    expect(normalizeBlocks(blocks)).toEqual([{ type: "divider" }, { type: "section", text: { type: "mrkdwn", text: "kept" } }]);
  });

  test("a section with empty text but fields keeps its fields", () => {
    const fields = [{ type: "mrkdwn", text: "a" }];
    expect(normalizeBlocks([{ type: "section", text: { type: "mrkdwn", text: "" }, fields }])).toEqual([{ type: "section", fields }]);
  });

  test("a fence of nothing but empty blocks is not usable Block Kit, so it is shown as code", () => {
    expect(parseKit('[{"type":"markdown","text":""}]')).toBeUndefined();
    const segs = splitBlockKit('```blockkit\n[{"type":"markdown","text":""}]\n```\n');
    expect(segs.map((s) => s.kind)).toEqual(["text"]);
  });

  test("the fix applies to a fence in a reply", () => {
    const m = toBlockMessage(`\`\`\`blockkit\n${TABLE_WITH_EMPTY_CELL}\n\`\`\``);
    expect(JSON.stringify(m?.blocks)).not.toContain('"text":""');
  });
});

describe("blocksToText", () => {
  test("a table is lines of cells; an empty cell is a dash", () => {
    expect(blocksToText([{ type: "table", rows: [[{ type: "raw_text", text: "a" }, { type: "raw_text", text: "" }]] }])).toBe("a | -");
  });

  test("other blocks give the text they hold, cards their titles", () => {
    expect(
      blocksToText([
        { type: "section", text: { type: "mrkdwn", text: "hello" }, fields: [{ type: "mrkdwn", text: "f1" }] },
        { type: "divider" },
        { type: "carousel", elements: [{ type: "card", title: { type: "mrkdwn", text: "T" }, body: { type: "mrkdwn", text: "B" } }] },
      ]),
    ).toBe("hello\nf1\n\nT\nB");
  });

  test("nothing to say is an empty string", () => {
    expect(blocksToText([{ type: "divider" }, { type: "alert" }])).toBe("");
  });
});
