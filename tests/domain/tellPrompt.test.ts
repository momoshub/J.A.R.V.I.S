import { describe, expect, test } from "bun:test";
import { NO_REPLY, TELL_PREFIX, tellPrompt } from "../../src/domain/tellPrompt.ts";
import { isSilenceNote } from "../../src/domain/silence.ts";

describe("tellPrompt", () => {
  test("marks the turn as an internal steer and carries the message and sender", () => {
    const p = tellPrompt("U1", "reset main");
    expect(p.startsWith(TELL_PREFIX)).toBe(true);
    expect(p).toContain("<@U1>");
    expect(p).toContain("reset main");
  });

  test("tells the session not to acknowledge, and how to end silently", () => {
    const p = tellPrompt("U1", "x");
    expect(p).toContain("Do NOT acknowledge");
    expect(p).toContain(NO_REPLY);
  });

  test("the sentinel it asks for is one the turn runner drops", () => {
    expect(isSilenceNote(NO_REPLY)).toBe(true);
  });
});
