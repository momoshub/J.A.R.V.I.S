import { describe, expect, test } from "bun:test";
import { DEFAULT_SNUB_REPLY, formatSnubbed, isSnubbed, parseSnubbed } from "../../src/domain/snub.ts";

describe("parseSnubbed", () => {
  test("the shapes a person would type", () => {
    expect(parseSnubbed("U0ALEX00001,U0USER00002")).toEqual(["U0ALEX00001", "U0USER00002"]);
    expect(parseSnubbed(" U1ABCDE , U2ABCDE ")).toEqual(["U1ABCDE", "U2ABCDE"]);
    expect(parseSnubbed("<@U1ABCDE|someone>")).toEqual(["U1ABCDE"]);
    expect(parseSnubbed("U1ABCDE\nU2ABCDE")).toEqual(["U1ABCDE", "U2ABCDE"]);
  });

  test("nothing configured is nobody snubbed", () => {
    expect(parseSnubbed()).toEqual([]);
    expect(parseSnubbed("")).toEqual([]);
    expect(parseSnubbed("  ,  ")).toEqual([]);
  });

  test("junk is dropped rather than turning into an id", () => {
    expect(parseSnubbed("nope,U1ABCDE")).toEqual(["U1ABCDE"]);
  });

  test("duplicates collapse, so a list cannot snub twice", () => {
    expect(parseSnubbed("U1ABCDE,U1ABCDE")).toEqual(["U1ABCDE"]);
  });

  test("it round-trips", () => {
    expect(parseSnubbed(formatSnubbed(["U1ABCDE", "U2ABCDE"]))).toEqual(["U1ABCDE", "U2ABCDE"]);
  });
});

describe("isSnubbed", () => {
  test("matches whatever case it arrives in", () => {
    expect(isSnubbed(["U1ABCDE"], "u1abcde")).toBe(true);
    expect(isSnubbed(["U1ABCDE"], "U9ZZZZZ")).toBe(false);
    expect(isSnubbed([], "U1ABCDE")).toBe(false);
  });
});

describe("the default reply", () => {
  test("names nobody - this is an open codebase", () => {
    expect(DEFAULT_SNUB_REPLY).not.toMatch(/<@U[A-Z0-9]+>/);
  });
});
