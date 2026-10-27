import { describe, expect, test } from "bun:test";
import { promptFingerprint } from "../../src/domain/promptFingerprint.ts";
import { buildSystemPrompt } from "../../src/domain/personality.ts";

const fp = (base?: string) => promptFingerprint(buildSystemPrompt as never, base);

describe("promptFingerprint", () => {
  test("the same rules give the same fingerprint", () => {
    expect(fp("a persona")).toBe(fp("a persona"));
  });

  test("changing the persona changes it", () => {
    // this is what the whole mechanism is for: an edited persona must not keep
    // running in threads that were already open
    expect(fp("reply in the person's language")).not.toBe(fp("reply in the room's language"));
  });

  test("it tracks the real rules, so a code change to them moves it", () => {
    // built from the actual prompt, so if OPERATING_RULES changes tomorrow this
    // value changes with it and live sessions are reopened
    const built = buildSystemPrompt({ botName: "fingerprint", learnings: [], base: "x" });
    expect(built).toContain("Operating rules");
    expect(fp("x")).toMatch(/^[0-9a-f]{16}$/);
  });

  test("it hashes only the rules: no learnings, nothing per-turn", () => {
    // teaching a fact is additive and happens often; it must not throw away the
    // context of every open thread. Nor must who happens to be in the channel
    let seen: Record<string, unknown> = {};
    promptFingerprint(((o: Record<string, unknown>) => {
      seen = o;
      return "x";
    }) as never, "persona");

    expect(seen.learnings).toEqual([]);
    expect(seen.base).toBe("persona");
    expect(seen).not.toHaveProperty("participants");
    expect(seen).not.toHaveProperty("reactable");
    expect(seen).not.toHaveProperty("runTicket");
    expect(seen).not.toHaveProperty("channelId");
  });
});
