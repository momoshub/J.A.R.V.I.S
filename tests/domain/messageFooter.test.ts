import { describe, expect, test } from "bun:test";
import {
  clockFallback,
  FOOTER_BLOCK_ID,
  footerBlock,
  footerLine,
  offsetLabel,
  restamp,
  MARKDOWN_LIMIT,
  sectionChunks,
  signedSections,
  signedText,
  SIGNATURES,
  updatedStamp,
  withFooter,
} from "../../src/domain/messageFooter.ts";
import { MAX_BLOCKS } from "../../src/domain/blockKit.ts";
import { SECTION_LIMIT } from "../../src/domain/slackFormat.ts";

// 2026-11-08 07:32:00 UTC = 14:32 at +07
const AT = Date.UTC(2026, 10, 8, 7, 32, 0);
const SECS = AT / 1000;
const ICT = 420;

describe("the time it shows", () => {
  test("offsets read like a clock: whole hours short, half hours with minutes", () => {
    expect(offsetLabel(420)).toBe("+07");
    expect(offsetLabel(0)).toBe("+00");
    expect(offsetLabel(-330)).toBe("-05:30");
    expect(offsetLabel(345)).toBe("+05:45");
  });

  test("the fallback is the host's wall clock with its offset", () => {
    expect(clockFallback(AT, ICT)).toBe("2026-11-08 14:32 +07");
    // the offset can move the date too
    expect(clockFallback(Date.UTC(2026, 10, 8, 20, 5), ICT)).toBe("2026-11-09 03:05 +07");
  });

  test("the stamp is a Slack date token, so each reader sees their own timezone", () => {
    expect(updatedStamp(AT, ICT)).toBe(`updated <!date^${SECS}^{date_short_pretty} {time}|2026-11-08 14:32 +07>`);
  });
});

describe("footerLine", () => {
  test("signature, then what the turn reported, then when it was last written - one line", () => {
    const line = footerLine("Jarvis", AT, "claude-opus-5-5 · in 95.9k · $1.30 · 3m 16s", ICT);
    expect(line).toBe(
      `Jarvis · claude-opus-5-5 · in 95.9k · $1.30 · 3m 16s · updated <!date^${SECS}^{date_short_pretty} {time}|2026-11-08 14:32 +07>`,
    );
    expect(line).not.toContain("\n");
  });

  test("nothing reported means just the signature and the time", () => {
    expect(footerLine(SIGNATURES.innerChild, AT, undefined, ICT)).toBe(`inner child Jarvis · ${updatedStamp(AT, ICT)}`);
    expect(footerLine("watch", AT, "  ", ICT)).toBe(`watch · ${updatedStamp(AT, ICT)}`);
  });

  test("a blank signature is still signed, as Jarvis", () => {
    expect(footerLine(" ", AT, undefined, ICT).startsWith("Jarvis · ")).toBe(true);
  });
});

describe("blocks", () => {
  const line = footerLine("Jarvis", AT, undefined, ICT);

  test("the footer is a context block carrying the id an edit finds it by", () => {
    expect(footerBlock(line)).toEqual({
      type: "context",
      block_id: FOOTER_BLOCK_ID,
      elements: [{ type: "mrkdwn", text: line }],
    });
  });

  test("withFooter replaces a footer already there rather than stacking a second one", () => {
    const once = withFooter([{ type: "markdown", text: "hi" }], line);
    const twice = withFooter(once, footerLine("watch", AT, undefined, ICT));
    expect(twice).toHaveLength(2);
    expect(JSON.stringify(twice[1])).toContain("watch · ");
  });

  test("a full message is clipped so the footer still fits Slack's 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ type: "section", text: { type: "mrkdwn", text: `${i}` } }));
    const out = withFooter(many, line);
    expect(out).toHaveLength(MAX_BLOCKS);
    expect(out.at(-1)).toMatchObject({ block_id: FOOTER_BLOCK_ID });
  });

  test("a plain post becomes a markdown block plus the footer, keeping its text fallback", () => {
    const msg = signedText("hello *there*", line);
    expect(msg.text).toBe("hello *there*");
    expect(msg.blocks).toEqual([{ type: "markdown", text: "hello *there*" }, footerBlock(line)]);
  });

  test("a long plain post stays one markdown block, so Slack does not fold it behind Show more", () => {
    const long = `${"a ".repeat(2000)}\n${"b ".repeat(2000)}`;
    const msg = signedText(long, line);
    expect(msg.blocks).toEqual([{ type: "markdown", text: long }, footerBlock(line)]);
  });

  test("blank text posts just the footer, with a non-empty fallback", () => {
    expect(signedText("", line)).toEqual({ text: " ", blocks: [footerBlock(line)] });
  });

  test("text past Slack's markdown cap carries on in sections, nothing lost", () => {
    const para = `${"w ".repeat(1000)}\n`;
    const huge = para.repeat(9).trimEnd(); // ~18k: over the 12k markdown cap
    const msg = signedText(huge, line);
    const [head, ...rest] = msg.blocks.slice(0, -1) as unknown as ({ type: "markdown"; text: string } | { type: "section"; text: { text: string } })[];
    expect(head?.type).toBe("markdown");
    expect((head as { text: string }).text.length).toBeLessThanOrEqual(MARKDOWN_LIMIT);
    expect(rest.length).toBeGreaterThan(1);
    for (const b of rest) {
      expect(b.type).toBe("section");
      expect((b as { text: { text: string } }).text.text.length).toBeLessThanOrEqual(SECTION_LIMIT);
    }
    const all = [(head as { text: string }).text, ...rest.map((b) => (b as { text: { text: string } }).text.text)];
    expect(all.join("\n")).toBe(huge);
    expect(msg.blocks.filter((b) => b.type === "markdown")).toHaveLength(1);
    expect(msg.blocks.at(-1)).toMatchObject({ block_id: FOOTER_BLOCK_ID });
  });

  test("signedSections: a long post split so every section stays under Slack's 3000", () => {
    const msg = signedSections(`${"a ".repeat(2000)}\n${"b ".repeat(2000)}`, line);
    const sections = msg.blocks.slice(0, -1) as unknown as { type: string; text: { text: string } }[];
    expect(sections.length).toBeGreaterThan(2);
    for (const s of sections) {
      expect(s.type).toBe("section");
      expect(s.text.text.length).toBeLessThanOrEqual(SECTION_LIMIT);
    }
    expect(sections.map((s) => s.text.text).join("")).toBe(`${"a ".repeat(2000)}${"b ".repeat(2000)}`);
    expect(msg.blocks.at(-1)).toMatchObject({ block_id: FOOTER_BLOCK_ID });
  });
});

describe("sectionChunks", () => {
  test("short text is one chunk, blank text none", () => {
    expect(sectionChunks("hello")).toEqual(["hello"]);
    expect(sectionChunks("  \n ")).toEqual([]);
  });

  test("a single line over the limit is hard-cut, nothing lost", () => {
    const giant = "x".repeat(7000);
    const chunks = sectionChunks(giant);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(SECTION_LIMIT);
    expect(chunks.join("")).toBe(giant);
  });

  test("one huge line inside a fence is cut into fenced chunks, none empty", () => {
    const chunks = sectionChunks(`\`\`\`\n${"q".repeat(10_000)}\n\`\`\``);
    expect(chunks.length).toBe(4);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(SECTION_LIMIT);
      expect(c).toStartWith("```\n");
      expect(c).toEndWith("\n```");
      expect(c.replace(/[`\s]/g, "")).not.toBe("");
    }
  });

  test("a fence closing exactly at the limit adds no empty code block", () => {
    for (let n = SECTION_LIMIT - 20; n < SECTION_LIMIT + 10; n++) {
      const chunks = sectionChunks(`\`\`\`\n${"a".repeat(n - 8)}\n\`\`\`\nafter`);
      for (const c of chunks) {
        expect(c.length).toBeLessThanOrEqual(SECTION_LIMIT);
        expect(c.replace(/[`\s]/g, "")).not.toBe("");
      }
    }
  });

  test("a code fence crossing a cut is closed and reopened, so both halves render as code", () => {
    const code = Array.from({ length: 200 }, (_, i) => `line ${i} ${"y".repeat(20)}`).join("\n");
    const chunks = sectionChunks(`before\n\`\`\`\n${code}\n\`\`\`\nafter`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(SECTION_LIMIT);
      // every chunk holds an even number of fences: opened and closed inside it
      expect((c.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
    expect(chunks[1]?.startsWith("```")).toBe(true);
    expect(chunks.at(-1)?.endsWith("after")).toBe(true);
  });
});

describe("restamp", () => {
  const later = AT + 3 * 60_000;

  test("an edit moves only the time: signature, usage and step summary stay", () => {
    const text = `🔧 4 steps\n${footerLine("workflow worker", AT, "claude-opus-5-5 · $0.20 · 1m 2s", ICT)}`;
    const before = [{ type: "markdown", text: "the answer" }, { type: "context", block_id: FOOTER_BLOCK_ID, elements: [{ type: "mrkdwn", text }] }];
    const after = restamp(before, "Jarvis", later, ICT);
    expect(after[0]).toEqual(before[0]);
    const line = (after[1] as { elements: { text: string }[] }).elements[0]!.text;
    expect(line).toBe(`🔧 4 steps\nworkflow worker · claude-opus-5-5 · $0.20 · 1m 2s · ${updatedStamp(later, ICT)}`);
  });

  test("a message with no footer yet - one the model posted itself - is signed now", () => {
    const after = restamp([{ type: "section", text: { type: "mrkdwn", text: "Which?" } }], "Jarvis", later, ICT);
    expect(after).toHaveLength(2);
    expect(after[1]).toEqual(footerBlock(footerLine("Jarvis", later, undefined, ICT)));
  });

  test("a footer missing its stamp gains one", () => {
    const before = [{ type: "context", block_id: FOOTER_BLOCK_ID, elements: [{ type: "mrkdwn", text: "Jarvis" }] }];
    const line = (restamp(before, "Jarvis", later, ICT)[0] as { elements: { text: string }[] }).elements[0]!.text;
    expect(line).toBe(`Jarvis · ${updatedStamp(later, ICT)}`);
  });

  test("a message already at 50 blocks keeps them all rather than gaining a footer", () => {
    const full = Array.from({ length: MAX_BLOCKS }, (_, i) => ({ type: "section", text: { type: "mrkdwn", text: `${i}` } }));
    expect(restamp(full, "Jarvis", later, ICT)).toEqual(full);
  });

  test("it does not touch the blocks it was given", () => {
    const before = [{ type: "context", block_id: FOOTER_BLOCK_ID, elements: [{ type: "mrkdwn", text: footerLine("Jarvis", AT, undefined, ICT) }] }];
    const copy = JSON.stringify(before);
    restamp(before, "Jarvis", later, ICT);
    expect(JSON.stringify(before)).toBe(copy);
  });
});
