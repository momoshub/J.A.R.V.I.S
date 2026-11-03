import { describe, expect, test } from "bun:test";
import { editDistance, nearestCommand } from "../../src/domain/commandSuggest.ts";

const NAMES = ["help", "ping", "whoami", "learn", "bomb", "approve", "review", "add", "ticket", "sys"];

describe("nearestCommand", () => {
  test("the real near misses out of the command log", () => {
    expect(nearestCommand("hel[", NAMES)).toBe("help");
    expect(nearestCommand("bomp", NAMES)).toBe("bomb");
    expect(nearestCommand("approvel", NAMES)).toBe("approve");
    expect(nearestCommand("who", NAMES)).toBe("whoami");
    expect(nearestCommand("learns", NAMES)).toBe("learn");
  });

  test("a name that exists is not a suggestion", () => {
    expect(nearestCommand("help", NAMES)).toBeUndefined();
  });

  test("something genuinely unrelated gets nothing", () => {
    expect(nearestCommand("deploy-the-whole-cluster", NAMES)).toBeUndefined();
    expect(nearestCommand("", NAMES)).toBeUndefined();
  });

  test("a short word is not dragged two edits to a different command", () => {
    // `add` and `sys` are three letters; almost anything is two edits away
    expect(nearestCommand("xyz", NAMES)).toBeUndefined();
  });

  test("a half-typed name is a prefix, and the shortest match wins", () => {
    expect(nearestCommand("pin", NAMES)).toBe("ping");
    expect(nearestCommand("re", NAMES)).toBe("review");
  });
});

describe("editDistance", () => {
  test("counts edits", () => {
    expect(editDistance("", "")).toBe(0);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("abc", "abd")).toBe(1);
    expect(editDistance("abc", "ab")).toBe(1);
  });

  test("stops counting past the bound instead of walking the whole matrix", () => {
    expect(editDistance("abcdef", "zzzzzz", 2)).toBeGreaterThan(2);
  });
});
