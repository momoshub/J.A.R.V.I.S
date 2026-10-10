import { describe, expect, test } from "bun:test";
import { describeUiAccess, needsAttention, readUiAccess } from "../../src/domain/uiAccess.ts";

describe("readUiAccess", () => {
  test("a clean run means the permission is in place", () => {
    expect(readUiAccess({ exitCode: 0, stderr: "" }, "darwin")).toBe("granted");
  });

  test("the permission error is recognised in the wordings macOS uses", () => {
    const refusals = [
      "execution error: Not authorized to send Apple events to System Events. (-1743)",
      "osascript is not allowed assistive access. (-1743)",
      "error -1743",
      "accessibility access is required",
    ];
    for (const stderr of refusals) {
      expect(readUiAccess({ exitCode: 1, stderr }, "darwin")).toBe("denied");
    }
  });

  test("another failure is unknown, never reported as a missing permission", () => {
    // saying someone forgot a permission when the tool simply was not there
    // sends them to System Settings to fix something that is not broken
    expect(readUiAccess({ exitCode: -1, stderr: "spawn osascript ENOENT" }, "darwin")).toBe("unknown");
    expect(readUiAccess({ exitCode: 2, stderr: "syntax error" }, "darwin")).toBe("unknown");
  });

  test("off macOS there is nothing to report", () => {
    expect(readUiAccess({ exitCode: 1, stderr: "-1743" }, "linux")).toBe("not-applicable");
    expect(readUiAccess({ exitCode: 0, stderr: "" }, "win32")).toBe("not-applicable");
  });
});

test("only a refusal asks for someone's attention", () => {
  expect(needsAttention("denied")).toBe(true);
  for (const a of ["granted", "unknown", "not-applicable"] as const) {
    expect(needsAttention(a)).toBe(false);
  }
});

describe("describeUiAccess", () => {
  test("a refusal names the cause and the binary to grant", () => {
    // by the time anyone reads this they have forgotten the grant is bound to a
    // path, and that upgrading the runtime moves it
    const line = describeUiAccess("denied", "/opt/homebrew/bin/bun");
    expect(line).toContain("REFUSED");
    expect(line).toContain("an upgrade moves it");
    expect(line).toContain("/opt/homebrew/bin/bun");
  });

  test("the other states read plainly", () => {
    expect(describeUiAccess("granted")).toContain("allowed");
    expect(describeUiAccess("not-applicable")).toContain("not applicable");
    expect(describeUiAccess("unknown")).toContain("could not be determined");
  });
});
