import { describe, expect, test } from "bun:test";
import { isNotionUrl, parseNoteArgs, unwrap } from "../../src/domain/noteTarget.ts";

describe("isNotionUrl", () => {
  test("the shapes people actually paste", () => {
    expect(isNotionUrl("https://www.notion.so/acme/Runbook-1a2b3c4d5e6f7081920a1b2c3d4e5f60")).toBe(true);
    expect(isNotionUrl("<https://notion.so/abc|Runbook>")).toBe(true);
    expect(isNotionUrl("1a2b3c4d5e6f7081920a1b2c3d4e5f60")).toBe(true);
    expect(isNotionUrl("1a2b3c4d-5e6f-7081-920a-1b2c3d4e5f60")).toBe(true);
  });

  test("a title is not a page", () => {
    expect(isNotionUrl("Deployment Runbook")).toBe(false);
    expect(isNotionUrl("https://github.com/o/r/pull/1")).toBe(false);
    expect(isNotionUrl("")).toBe(false);
  });
});

describe("parseNoteArgs", () => {
  test("creating is still the default", () => {
    const a = parseNoteArgs(["/tmp/doc.md", "Deployment", "Runbook"]);
    expect(a.ok && a.mode).toBe("create");
    expect(a.ok && a.title).toBe("Deployment Runbook");
    expect(a.ok && a.target).toBeUndefined();
  });

  test("a bare page url means update that page", () => {
    const a = parseNoteArgs(["/tmp/doc.md", "https://notion.so/Runbook-1a2b3c4d5e6f7081920a1b2c3d4e5f60"]);
    expect(a.ok && a.mode).toBe("replace");
    expect(a.ok && a.target).toContain("notion.so");
  });

  test("Slack's link wrapping does not reach the page", () => {
    const a = parseNoteArgs(["/tmp/doc.md", "<https://notion.so/Run-1a2b3c4d5e6f7081920a1b2c3d4e5f60|Run>"]);
    expect(a.ok && a.target).toBe("https://notion.so/Run-1a2b3c4d5e6f7081920a1b2c3d4e5f60");
  });

  test("the flags say it out loud", () => {
    const into = parseNoteArgs(["/tmp/d.md", "--into", "https://notion.so/x1a2b3c4d5e6f7081920a1b2c3d4e5f60"]);
    expect(into.ok && into.mode).toBe("replace");
    const add = parseNoteArgs(["/tmp/d.md", "--append", "1a2b3c4d5e6f7081920a1b2c3d4e5f60"]);
    expect(add.ok && add.mode).toBe("append");
  });

  test("a flag with no page is refused rather than guessed at", () => {
    const a = parseNoteArgs(["/tmp/d.md", "--into"]);
    expect(a.ok).toBe(false);
    expect(!a.ok && a.error).toContain("needs the page");
  });

  test("a target that is not a page is refused", () => {
    const a = parseNoteArgs(["/tmp/d.md", "--into", "the runbook"]);
    expect(a.ok).toBe(false);
    expect(!a.ok && a.error).toContain("not a Notion page");
  });

  test("a title still survives alongside a target", () => {
    const a = parseNoteArgs(["/tmp/d.md", "--into", "1a2b3c4d5e6f7081920a1b2c3d4e5f60", "New", "Title"]);
    expect(a.ok && a.title).toBe("New Title");
    expect(a.ok && a.mode).toBe("replace");
  });

  test("no file is no note", () => {
    expect(parseNoteArgs([]).ok).toBe(false);
  });
});

describe("unwrap", () => {
  test("takes the url out of Slack's wrapper", () => {
    expect(unwrap("<https://x.test/a|label>")).toBe("https://x.test/a");
    expect(unwrap("  plain  ")).toBe("plain");
  });
});
