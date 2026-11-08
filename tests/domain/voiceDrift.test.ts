import { describe, expect, test } from "bun:test";
import {
  DRIFT_NUDGE_MARK,
  detectDrift,
  driftFollowUp,
  driftKey,
  driftLogMessage,
  driftNudge,
  isDriftNudge,
  parseLanguageDrift,
  pickReplyTs,
} from "../../src/domain/voiceDrift.ts";
import { isSilenceNote } from "../../src/domain/silence.ts";

const rules = (reply: string) => detectDrift(reply).map((h) => h.rule);

describe("detectDrift", () => {
  test("a clean reply in the voice rules has no drift", () => {
    expect(detectDrift("done, merged it\nthe deploy is green, nothing else to do")).toEqual([]);
  });

  test("a paragraph starting with a capital is drift, with the line as the excerpt", () => {
    const [hit] = detectDrift("all good here\n\nThe deploy failed on step 3");
    expect(hit).toEqual({ rule: "capital", excerpt: "The deploy failed on step 3" });
  });

  test("the word I is not drift, in any of its forms", () => {
    expect(rules("I merged it\nI'm on it\nI'll check\nI've looked\nI'd say yes")).toEqual([]);
  });

  test("an acronym is not a capitalised start", () => {
    expect(rules("PR #81 is merged\nAWS looks fine")).toEqual([]);
    expect(rules("PRs are merged\nURLs work")).toEqual([]);
    expect(rules("Prs are merged")).toEqual(["capital"]);
  });

  test("bullets, quotes, emoji and emphasis before the first word do not hide a capital", () => {
    expect(rules("- Fixed it")).toEqual(["capital"]);
    expect(rules("> Quoted start")).toEqual(["capital"]);
    expect(rules(":white_check_mark: Done")).toEqual(["capital"]);
    expect(rules("✅ Done")).toEqual(["capital"]);
    expect(rules("_Done_ now")).toEqual(["capital"]);
    expect(rules("- fixed it\n:white_check_mark: done")).toEqual([]);
  });

  test("a non-latin capital counts too, a caseless script does not", () => {
    expect(rules("Đã xong")).toEqual(["capital"]);
    expect(rules("đã xong")).toEqual([]);
    expect(rules("完成了")).toEqual([]);
  });

  test("forbidden characters: em/en dash, semicolon, arrows", () => {
    expect(rules("done — merged")).toEqual(["dash"]);
    expect(rules("pages 1–3")).toEqual(["dash"]);
    expect(rules("done; merged")).toEqual(["semicolon"]);
    expect(rules("staging → prod")).toEqual(["arrow"]);
    expect(rules("go ⇒ there")).toEqual(["arrow"]);
    expect(rules("next ➜ step")).toEqual(["arrow"]);
    expect(rules("a plain hyphen - is fine")).toEqual([]);
  });

  test("markdown headings and double asterisk bold", () => {
    expect(rules("## summary\nall fine")).toContain("heading");
    expect(rules("this is **important** now")).toEqual(["bold"]);
    expect(rules("this is *slack bold* now")).toEqual([]);
  });

  test("code blocks and inline code are not counted", () => {
    const reply = "ran it\n```\nconst a = 1; // Arrow → here\nThe End — of code\n## not a heading\n```\nand `x; y — z` too";
    expect(detectDrift(reply)).toEqual([]);
  });

  test("an unclosed code fence still hides what follows it", () => {
    expect(detectDrift("look\n```\nSELECT 1;")).toEqual([]);
  });

  test("links, mentions, channels, bare urls and entities are not counted", () => {
    expect(rules("<@U123> can you look")).toEqual([]);
    expect(rules("see <https://x.io/a;b|Release Notes> here")).toEqual([]);
    expect(rules("<#C123|General> has it")).toEqual([]);
    expect(rules("see https://x.io/a;b?c=Upper")).toEqual([]);
    expect(rules("this &amp; that")).toEqual([]);
    expect(rules("read [The Doc](https://x.io) now")).toEqual([]);
  });

  test("a mention does not shield the word after it", () => {
    expect(rules("<@U123> Thanks for that")).toEqual(["capital"]);
  });

  test("each rule is reported once, in a fixed order, whatever else is broken", () => {
    expect(rules("Done — ok; yes → **b**\n# Head\nAlso this")).toEqual([
      "capital",
      "dash",
      "semicolon",
      "arrow",
      "heading",
      "bold",
    ]);
  });
});

describe("the nudge", () => {
  const hits = [{ rule: "capital" as const, excerpt: "The deploy failed" }];

  test("names the rule, quotes the start, asks for a content re-check and no edit", () => {
    const n = driftNudge(hits);
    expect(n.startsWith(DRIFT_NUDGE_MARK)).toBe(true);
    expect(n).toContain("capital letter");
    expect(n).toContain('"The deploy failed"');
    expect(n).toContain("CONTENT");
    expect(n).toContain("never edit or delete the old message");
    expect(n).toContain("not from the person in this thread");
  });

  test("its no-change answer is a phrase the post boundary drops", () => {
    expect(driftNudge(hits)).toContain("reply with exactly: nothing to add");
    expect(isSilenceNote("nothing to add")).toBe(true);
  });

  test("a turn started by a nudge is recognised", () => {
    expect(isDriftNudge(driftNudge(hits))).toBe(true);
    expect(isDriftNudge("can you check the deploy")).toBe(false);
  });
});

describe("the log lines", () => {
  test("the log message links the drifted reply and carries the full nudge", () => {
    const hits = [{ rule: "semicolon" as const, excerpt: "done; merged" }];
    const nudge = driftNudge(hits);
    const msg = driftLogMessage({ id: 3, channelId: "C1", threadTs: "1.1", replyTs: "2.2", hits, nudge });
    expect(msg).toContain("drift #3");
    expect(msg).toContain("https://slack.com/archives/C1/p22?thread_ts=1.1&cid=C1|drifted reply");
    expect(msg).toContain("a semicolon");
    expect(msg).toContain("> done; merged");
    expect(msg).toContain(nudge);
  });

  test("with no reply ts it still links the thread", () => {
    const msg = driftLogMessage({ id: 1, channelId: "C1", threadTs: "1.1", replyTs: "", hits: [], nudge: "n" });
    expect(msg).toContain("https://slack.com/archives/C1/p11|thread");
  });

  test("each outcome reads differently in the log thread", () => {
    expect(driftFollowUp("corrected", "fixed the date", "<link|correction>")).toContain("> fixed the date");
    expect(driftFollowUp("corrected", "x", "<link|correction>")).toContain("<link|correction>");
    expect(driftFollowUp("no_change", "")).toContain("no change needed");
    expect(driftFollowUp("no_reply", "")).toContain("no reply");
    expect(driftFollowUp("failed", "boom")).toContain("boom");
  });
});

describe("finding the drifted reply", () => {
  const msgs = [
    { ts: "1000.000100", own: false, text: "question" },
    { ts: "1001.000100", own: true, text: "The first answer, about deploys" },
    { ts: "1002.000100", own: true, text: "a later note" },
  ];

  test("matches by time window and opening text", () => {
    expect(pickReplyTs(msgs, 1_000_000, 1_003_000, "The first answer, about **deploys**")).toBe("1001.000100");
  });

  test("falls back to the last own message in the window", () => {
    expect(pickReplyTs(msgs, 1_000_000, 1_003_000, "something else")).toBe("1002.000100");
  });

  test("nothing in the window is undefined", () => {
    expect(pickReplyTs(msgs, 2_000_000, 2_001_000, "x")).toBeUndefined();
  });

  test("the key is the reply ts, else the stored message id", () => {
    expect(driftKey("C1", "2.2", 9)).toBe("C1:2.2");
    expect(driftKey("C1", "", 9)).toBe("C1:m9");
  });
});

describe("parseLanguageDrift", () => {
  test("reads only drift items, by turn number", () => {
    const raw = JSON.stringify([
      { fingerprint: "x", title: "t", severity: "bug", channelId: "C" },
      { drift: "language", turn: 2, excerpt: "chào anh" },
      { drift: "language", turn: "3", excerpt: "ok" },
      { drift: "capital", turn: 1 },
      { drift: "language", turn: 0 },
    ]);
    expect(parseLanguageDrift(raw)).toEqual([
      { turn: 2, excerpt: "chào anh" },
      { turn: 3, excerpt: "ok" },
    ]);
  });

  test("junk is nothing", () => {
    expect(parseLanguageDrift("no")).toEqual([]);
    expect(parseLanguageDrift("[{bad")).toEqual([]);
  });
});
