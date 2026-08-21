import { describe, expect, test } from "bun:test";
import { annotateMentions, extractMentionIds, hasContent, mentionedId } from "../../src/domain/mentions.ts";

const names: Record<string, string> = { U0USER00001: "Jarvis", U1: "Kai" };
const resolve = (id: string) => names[id];

describe("extractMentionIds", () => {
  test("collects unique ids", () => {
    expect(extractMentionIds("<@U1> and <@U0USER00001> and <@U1>")).toEqual(["U1", "U0USER00001"]);
  });
  test("handles piped mentions", () => {
    expect(extractMentionIds("<@U1|kai> hi")).toEqual(["U1"]);
  });
});

describe("annotateMentions", () => {
  test("annotates a mention with the resolved name", () => {
    expect(annotateMentions("<@U0USER00001> is doing something", resolve)).toBe(
      "<@U0USER00001:Jarvis> is doing something",
    );
  });

  test("falls back to the bare id when unknown", () => {
    expect(annotateMentions("<@UNKNOWN> hi", resolve)).toBe("<@UNKNOWN> hi");
  });

  test("annotates multiple and piped forms", () => {
    expect(annotateMentions("<@U1|old> tell <@U0USER00001>", resolve)).toBe("<@U1:Kai> tell <@U0USER00001:Jarvis>");
  });

  test("leaves an already-annotated mention untouched", () => {
    expect(annotateMentions("<@U1:Kai> hi", resolve)).toBe("<@U1:Kai> hi");
  });
});

describe("hasContent", () => {
  test("false for mention-only / blank", () => {
    expect(hasContent("<@U1>")).toBe(false);
    expect(hasContent("<@U1:Kai>   ")).toBe(false);
    expect(hasContent("   ")).toBe(false);
  });
  test("true when there is real text", () => {
    expect(hasContent("<@U1> hi")).toBe(true);
  });
});

describe("mentionedId", () => {
  test("reads every form a mention can arrive in", () => {
    expect(mentionedId("<@U123ABC>")).toBe("U123ABC");
    expect(mentionedId("<@U123ABC|robin>")).toBe("U123ABC");
    // the annotated form is what commands actually receive, because the
    // transport annotates before anything parses arguments
    expect(mentionedId("<@U123ABC:Robin>")).toBe("U123ABC");
    expect(mentionedId("<@U123ABC:Robin Example>")).toBe("U123ABC");
    expect(mentionedId("U123ABC")).toBe("U123ABC");
    expect(mentionedId("W123ABC")).toBe("W123ABC");
  });

  test("what a mention annotates to still reads back", () => {
    const annotated = annotateMentions("<@U123ABC>", () => "Robin");
    expect(mentionedId(annotated)).toBe("U123ABC");
  });

  test("anything else is nobody", () => {
    for (const junk of [undefined, "", "robin", "@robin", "<#C123>", "<@u123abc>", "hello <@U1> there"]) {
      expect(mentionedId(junk)).toBeUndefined();
    }
  });
});

