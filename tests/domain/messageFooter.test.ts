import { describe, expect, test } from "bun:test";
import {
  clockFallback,
  FOOTER_BLOCK_ID,
  footerBlock,
  footerLine,
  offsetLabel,
  restamp,
  signedText,
  SIGNATURES,
  updatedStamp,
  withFooter,
} from "../../src/domain/messageFooter.ts";
import { MAX_BLOCKS } from "../../src/domain/blockKit.ts";

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

  test("a plain post becomes sections plus the footer, keeping its text fallback", () => {
    const msg = signedText("hello *there*", line);
    expect(msg.text).toBe("hello *there*");
    expect(msg.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: "hello *there*" } }, footerBlock(line)]);
  });

  test("a long plain post is split, since Slack refuses a section over 3000 chars", () => {
    const msg = signedText(`${"a ".repeat(2000)}\n${"b ".repeat(2000)}`, line);
    expect(msg.blocks.length).toBeGreaterThan(2);
    expect(msg.blocks.at(-1)?.block_id).toBe(FOOTER_BLOCK_ID);
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

  test("it does not touch the blocks it was given", () => {
    const before = [{ type: "context", block_id: FOOTER_BLOCK_ID, elements: [{ type: "mrkdwn", text: footerLine("Jarvis", AT, undefined, ICT) }] }];
    const copy = JSON.stringify(before);
    restamp(before, "Jarvis", later, ICT);
    expect(JSON.stringify(before)).toBe(copy);
  });
});
