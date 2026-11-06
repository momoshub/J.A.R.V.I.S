import { describe, expect, test } from "bun:test";
import { isDbFileSwapped } from "../../src/domain/dbHealth.ts";

describe("isDbFileSwapped", () => {
  test("only SQLITE_IOERR_VNODE means the file was replaced under the handle", () => {
    expect(isDbFileSwapped(Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR_VNODE" }))).toBe(true);
    expect(isDbFileSwapped(Object.assign(new Error("busy"), { code: "SQLITE_BUSY" }))).toBe(false);
    expect(isDbFileSwapped(new Error("plain"))).toBe(false);
    expect(isDbFileSwapped("SQLITE_IOERR_VNODE")).toBe(false);
    expect(isDbFileSwapped(null)).toBe(false);
  });
});
