import { describe, expect, test } from "bun:test";
import { causeOf, classifyRead, parseKey } from "../../src/domain/tokenKey.ts";

describe("tokenKey", () => {
  test("parseKey accepts only 32 bytes", () => {
    expect(parseKey(Buffer.alloc(32, 1).toString("base64") + "\n")).toHaveLength(32);
    expect(parseKey(Buffer.alloc(16).toString("base64"))).toBeUndefined();
    expect(parseKey("")).toBeUndefined();
  });

  test("classifyRead tells found, missing and unavailable apart", () => {
    expect(classifyRead({ status: 0, stdout: "abc\n", stderr: "" })).toEqual({ kind: "found", value: "abc" });
    expect(classifyRead({ status: 44, stdout: "", stderr: "" }).kind).toBe("missing");
    expect(classifyRead({ status: 1, stdout: "", stderr: "The specified item could not be found" }).kind).toBe("missing");
    expect(classifyRead({ status: 51, stdout: "", stderr: "nope" }).kind).toBe("unavailable");
  });

  test("causeOf scrubs secrets and takes one line", () => {
    const text = causeOf({ status: 1, stdout: "", stderr: "bad SECRET here\nsecond" }, ["SECRET"]);
    expect(text).toBe("security exited 1: bad [redacted] here");
  });
});

import { interactiveLine } from "../../src/domain/tokenKey.ts";
describe("interactiveLine", () => {
  test("quotes every word and escapes quotes and backslashes", () => {
    expect(interactiveLine(["add", "-s", 'a "b"', "c\\d"])).toBe('"add" "-s" "a \\"b\\"" "c\\\\d"\n');
  });
});
