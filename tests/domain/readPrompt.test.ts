import { describe, expect, test } from "bun:test";
import { readPrompt } from "../../src/domain/readPrompt.ts";

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

  test("it answers a question rather than reproducing the source", () => {
    // it posted an entire ClickHouse handbook across three messages into a
    // thread someone else had opened about a slow page. The answer - that the
    // handbook has no re-key procedure - was buried in paragraph two
    const p = readPrompt(req, "Bot");
    expect(p).toContain("ANSWERING A QUESTION, not mirroring a page");
    expect(p).toContain("the first line answers why you were sent");
    expect(p).toContain("never reproduce the source");
  });

  test("there is a hard ceiling, and a second message is the signal it was passed", () => {
    const p = readPrompt(req, "Bot");
    expect(p).toContain("fifteen lines is the ceiling");
    expect(p).toContain("you have stopped answering and started transcribing");
    expect(p).toContain("say the word");
  });

  test('"the page does not answer that" is a complete answer', () => {
    expect(readPrompt(req, "Bot")).toContain("is a complete and valuable answer");
  });

  test("it remembers whose thread it is posting into", () => {
    expect(readPrompt(req, "Bot")).toContain("it is somebody else's thread");
  });

  test("not being able to read something is an answer, not a failure to hide", () => {
    const p = readPrompt(req, "Bot");
    expect(p).toContain("say which part and why");
    expect(p).toContain("that is a real answer, not a failure");
  });
});

describe("claude.ai artifact links", () => {
  const target = "https://claude.ai/artifact/abc";
  const withHelper = readPrompt(
    { target, channelId: "C1", askedBy: "U1", artifactScript: "/bin/artifact-read.sh" },
    "Bot",
  );
  const without = readPrompt({ target, channelId: "C1", askedBy: "U1" }, "Bot");

  test("with the helper, it is told the one thing that CAN read an artifact", () => {
    // the Artifact tool is absent from `claude -p` (verified by forcing a call:
    // NO_SUCH_TOOL) but present in a full session, which the helper opens
    expect(withHelper).toContain("/bin/artifact-read.sh");
    expect(withHelper).toContain("three minutes");
  });

  test("without one, it says so and offers the way forward", () => {
    expect(without).toContain("nothing here can open one");
    expect(without).toContain("publish it as a Claude *Doc*");
    expect(without).not.toContain("/bin/artifact-read.sh");
  });

  test("either way it never web-fetches an artifact url", () => {
    // every artifact returns the same placeholder shell, so an empty page is
    // evidence of nothing
    for (const p of [withHelper, without]) {
      expect(p).toContain("NEVER fetch an artifact url over the web");
      expect(p).toContain("proves nothing at all");
    }
  });

  test("and never sends anyone to re-share what is already shared", () => {
    for (const p of [withHelper, without]) {
      expect(p).toContain("never ask anyone to re-share an artifact");
    }
  });
});
