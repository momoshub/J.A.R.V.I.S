import { describe, expect, test } from "bun:test";
import { readChatRules, readPrompt } from "../../src/domain/readPrompt.ts";

const req = { target: "https://x.slack.com/archives/C1/p1792422356053559", channelId: "D1", askedBy: "U1" };

describe("readPrompt", () => {
  test("it reads, and is told in terms it cannot misread that it must not post", () => {
    // the whole reason the connector was banned outright: a message sent
    // through it arrives under the authorising human's name, not the bot's
    const p = readPrompt(req, "Bot");
    expect(p).toContain("READ only");
    expect(p).toContain("never post into the conversation you are reading");
    expect(p).toContain("under your own name");
  });

  test("it is told how to take a permalink apart, since that is where it would guess", () => {
    expect(readPrompt(req, "Bot")).toContain("decimal point inserted before the last six digits");
  });

  test("it knows a link may lead to the document that is the actual content", () => {
    // "Paul posted a link" is not a summary when the link is the thing
    const p = readPrompt(req, "Bot");
    expect(p).toContain("trailing 32 hex characters");
    expect(p).toContain("Summarising \"Paul posted a link\" when the link is the content is not an answer");
  });

  test("the asker's angle is quoted when given, and a default stands in when not", () => {
    expect(readPrompt({ ...req, note: "just the decisions" }, "Bot")).toContain("just the decisions");
    expect(readPrompt(req, "Bot")).toContain("what is still open");
  });

  test("not being able to read something is an answer, not a failure to hide", () => {
    const p = readPrompt(req, "Bot");
    expect(p).toContain("say which part and why");
    expect(p).toContain("that is a real answer, not a failure");
  });
});

describe("readChatRules", () => {
  test("it tells the brain to escalate rather than refuse", () => {
    // it used to answer "my rules forbid the Slack connector", which was true
    // of posting and wrong about reading
    const r = readChatRules("X/jv");
    expect(r).toContain("X/jv read");
    expect(r).toContain("Run it yourself");
  });

  test("it covers every connector-backed source, not only Slack", () => {
    // the failure this exists for: handed a private Notion page it answered
    // "none of my commands can read Notion", which was simply untrue - the same
    // command had been reading the ticket tracker for weeks
    const r = readChatRules("X/jv");
    expect(r).toContain("not just Slack");
    expect(r).toContain("Notion page");
    expect(r).toContain("your credentials are the wrong ones");
  });

  test("a failed hand-rolled scrape is not evidence that something is private", () => {
    // it curled notion.so's internal API unauthenticated, got nothing back, and
    // reported the page as private twice
    const r = readChatRules("X/jv");
    expect(r).toContain("NEVER try to scrape a private service's internal API");
    expect(r).toContain("a conclusion you did not earn");
  });

  test("and keeps the one line that actually mattered", () => {
    expect(readChatRules("X/jv")).toContain("You may never POST this way");
  });
});
