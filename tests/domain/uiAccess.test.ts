import { describe, expect, test } from "bun:test";
import { describeUiAccess, needsAttention, readUiAccess } from "../../src/domain/uiAccess.ts";

describe("readUiAccess", () => {
  test("it reads the system's own answer about Accessibility", () => {
    expect(readUiAccess({ exitCode: 0, stdout: "true\n" }, "darwin")).toBe("granted");
    expect(readUiAccess({ exitCode: 0, stdout: "false\n" }, "darwin")).toBe("denied");
  });

  test("a refusal is reported as denied, not as a broken probe", () => {
    // the whole point: AXIsProcessTrusted answers false rather than erroring,
    // so a non-zero exit is never how a denial arrives
    expect(readUiAccess({ exitCode: 0, stdout: "false" }, "darwin")).toBe("denied");
  });

  test("a probe that did not run is unknown, never a missing permission", () => {
    // saying someone forgot a permission when the tool simply was not there
    // sends them to System Settings to fix something that is not broken
    expect(readUiAccess({ exitCode: -1, stdout: "spawn osascript ENOENT" }, "darwin")).toBe("unknown");
    expect(readUiAccess({ exitCode: 2, stdout: "" }, "darwin")).toBe("unknown");
    expect(readUiAccess({ exitCode: 0, stdout: "something else" }, "darwin")).toBe("unknown");
  });

  test("off macOS there is nothing to report", () => {
    expect(readUiAccess({ exitCode: 0, stdout: "false" }, "linux")).toBe("not-applicable");
    expect(readUiAccess({ exitCode: 0, stdout: "true" }, "win32")).toBe("not-applicable");
  });
});

test("only a refusal asks for someone's attention", () => {
  expect(needsAttention("denied")).toBe(true);
  for (const a of ["granted", "unknown", "not-applicable"] as const) {
    expect(needsAttention(a)).toBe(false);
  }
});

describe("describeUiAccess", () => {
  test("a refusal names the cause and EVERY binary that may need the grant", () => {
    // by the time anyone reads this they have forgotten the grant is bound to a
    // path, that upgrading moves it, and that the UI call may be attributed to
    // the CLI rather than the runtime - granting one of the two looks fixed
    const line = describeUiAccess("denied", "/opt/homebrew/bin/bun", "/opt/homebrew/bin/claude");
    expect(line).toContain("REFUSED");
    expect(line).toContain("an upgrade moves it");
    expect(line).toContain("/opt/homebrew/bin/bun");
    expect(line).toContain("/opt/homebrew/bin/claude");
  });

  test("an unknown path is simply left out", () => {
    const line = describeUiAccess("denied", "/opt/homebrew/bin/bun", undefined);
    expect(line).toContain("/opt/homebrew/bin/bun");
    expect(line).not.toContain("undefined");
  });

  test("the other states read plainly", () => {
    expect(describeUiAccess("granted")).toContain("allowed");
    expect(describeUiAccess("not-applicable")).toContain("not applicable");
    expect(describeUiAccess("unknown")).toContain("could not be determined");
  });
});
