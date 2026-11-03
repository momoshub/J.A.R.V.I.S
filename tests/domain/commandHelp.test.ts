import { describe, expect, test } from "bun:test";
import { asksForHelp, commandHelp } from "../../src/domain/commandHelp.ts";

describe("asksForHelp", () => {
  test("the words people type", () => {
    for (const w of ["help", "?", "--help", "-h", "usage", "how", "HELP"]) {
      expect(asksForHelp([w])).toBe(true);
    }
  });

  test("a real argument is not a question about the command", () => {
    expect(asksForHelp(["https://github.com/o/r/pull/1"])).toBe(false);
    expect(asksForHelp(["help", "me", "with", "this"])).toBe(false);
    expect(asksForHelp([])).toBe(false);
  });
});

describe("commandHelp", () => {
  test("says how to type it, what it does and who may", () => {
    const card = commandHelp(
      { name: "ticket", usage: "<what is wrong>", summary: "raise a bug", minRole: "pal", aliases: ["bug"] },
      "//jv",
    );
    expect(card).toContain("`//jv ticket <what is wrong>`");
    expect(card).toContain("raise a bug");
    expect(card).toContain("*pal*");
    expect(card).toContain("`bug`");
    expect(card).toContain("//jv help");
  });

  test("a command with no arguments or aliases still reads cleanly", () => {
    const card = commandHelp({ name: "ping", usage: "", summary: "are you alive", minRole: "pal" }, "//jv");
    expect(card).toContain("`//jv ping`");
    expect(card).not.toContain("also:");
  });
});
