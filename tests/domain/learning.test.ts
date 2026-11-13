import { describe, expect, test } from "bun:test";
import {
  AGENT_SOURCE,
  LEARNING_ACTION_PREFIX,
  LEARNING_APPROVE_ACTION,
  LEARNING_REJECT_ACTION,
  approvalCore,
  approvalText,
  parseLearnArgs,
  pendingApiMessage,
  pendingReply,
  refusalText,
  settledText,
} from "../../src/domain/learning.ts";

describe("parseLearnArgs", () => {
  test("a plain sentence is a fact", () => {
    expect(parseLearnArgs("  staging is at x.example.com ")).toEqual({ kind: "fact", text: "staging is at x.example.com" });
    expect(parseLearnArgs("")).toEqual({ kind: "fact", text: "" });
  });

  test("pending, approve <id> and reject <id> are the owner's subcommands", () => {
    expect(parseLearnArgs("pending")).toEqual({ kind: "pending" });
    expect(parseLearnArgs(" PENDING ")).toEqual({ kind: "pending" });
    expect(parseLearnArgs("approve 7")).toEqual({ kind: "approve", id: 7 });
    expect(parseLearnArgs("reject #12")).toEqual({ kind: "reject", id: 12 });
  });

  test("only the exact shapes count, so a sentence that opens with the word is still a fact", () => {
    expect(parseLearnArgs("pending reviews go to the owner")).toMatchObject({ kind: "fact" });
    expect(parseLearnArgs("approve of the new process")).toMatchObject({ kind: "fact" });
    expect(parseLearnArgs("approve 7 and then deploy")).toMatchObject({ kind: "fact" });
    expect(parseLearnArgs("reject abc")).toMatchObject({ kind: "fact" });
  });

  test("approve or reject with no id is a usage line, never a fact", () => {
    expect(parseLearnArgs("approve")).toEqual({ kind: "usage", verb: "approve" });
    expect(parseLearnArgs("Reject")).toEqual({ kind: "usage", verb: "reject" });
  });
});

describe("approval wording", () => {
  test("the fact is escaped so it cannot render a mention or a link", () => {
    const core = approvalCore("ping <!channel> and <https://evil.example|docs> & more");
    expect(core).toBe("> ping &lt;!channel&gt; and &lt;https://evil.example|docs&gt; &amp; more");
    expect(core).not.toContain("<!channel>");
  });

  test("a multi-line fact is shown on one line", () => {
    expect(approvalCore("one\n\n two")).toBe("> one two");
  });

  test("the DM says who asked, that nothing is saved, and carries the fact", () => {
    const text = approvalText(7, "ships on Fridays", "U0PAL0001");
    expect(text).toContain("<@U0PAL0001>");
    expect(text).toContain("learning #7");
    expect(text).toContain("NOT part of my memory until you approve");
    expect(text).toContain(approvalCore("ships on Fridays"));
    expect(approvalText(8, "x", AGENT_SOURCE)).toContain("one of my turns");
    expect(approvalText(8, "x", AGENT_SOURCE)).not.toContain("<@agent>");
  });

  test("the settled line names the owner and the decision", () => {
    expect(settledText("approved", 3, "a fact", "U0OWNER0001")).toContain("✅ learning #3 approved by <@U0OWNER0001>");
    expect(settledText("rejected", 3, "a fact", "U0OWNER0001")).toContain("❌ learning #3 rejected");
  });

  test("what the agent and the typist are told says it is not saved", () => {
    expect(pendingApiMessage(4)).toContain("Pending owner approval (#4)");
    expect(pendingApiMessage(4)).toContain("NOT saved");
    expect(pendingApiMessage(4)).toContain("Do not tell anyone you saved it");
    expect(pendingReply(4, "//bot")).toContain("pending (#4)");
    expect(pendingReply(4, "//bot")).toContain("NOT part of my memory yet");
    expect(pendingReply(4, "//bot")).toContain("//bot learn approve 4");
  });

  test("every refusal has its own words", () => {
    const all = (["not-owner", "from-turn", "unknown", "decided", "forged"] as const).map((r) => refusalText(r, 9));
    expect(new Set(all).size).toBe(5);
    expect(refusalText("unknown", 9)).toContain("#9");
  });

  test("the buttons carry the prefix the app routes on", () => {
    expect(LEARNING_APPROVE_ACTION.startsWith(LEARNING_ACTION_PREFIX)).toBe(true);
    expect(LEARNING_REJECT_ACTION.startsWith(LEARNING_ACTION_PREFIX)).toBe(true);
    expect(LEARNING_ACTION_PREFIX.startsWith("jv:")).toBe(true);
  });
});
