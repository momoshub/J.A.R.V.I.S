import { describe, expect, test } from "bun:test";
import { macUiRules } from "../../src/domain/macUi.ts";
import { buildSystemPrompt } from "../../src/domain/personality.ts";

describe("macUiRules", () => {
  test("nothing is offered when the helper is not wired up", () => {
    expect(macUiRules()).toBe("");
    expect(macUiRules("")).toBe("");
  });

  test("it names the commands and tells it to look before clicking", () => {
    const r = macUiRules("/x/mac-ui.js");
    expect(r).toContain("/x/mac-ui.js tree");
    expect(r).toContain("always `tree` or `find` before you `click`");
  });

  test("it rules out AppleScript by name, and explains -1712", () => {
    // the exact wrong turn it took: AppleScript needs Automation, which it does
    // not have, and it blamed a dialog that was not on screen
    const r = macUiRules("/x/mac-ui.js");
    expect(r).toContain("Do not reach for AppleScript");
    expect(r).toContain("-1712");
    expect(r).toContain("not a dialog waiting to be clicked");
  });

  test("it warns that Electron apps look empty to everything else", () => {
    expect(macUiRules("/x/mac-ui.js")).toContain("AXManualAccessibility");
  });

  test("it says out loud that this is somebody's real screen", () => {
    expect(macUiRules("/x/mac-ui.js")).toContain("REAL screen");
  });

  test("agent-desktop is offered first, and the browser is Brave", () => {
    expect(macUiRules("/x/mac-ui.js")).not.toContain("agent-desktop");
    const r = macUiRules("/x/mac-ui.js", "/opt/homebrew/bin/agent-desktop");
    expect(r).toContain("/opt/homebrew/bin/agent-desktop snapshot --app <app> -i --compact");
    expect(r).toContain("FIRST driver");
    expect(r).toContain("*Brave Browser* - not Arc");
    expect(r).toContain("STALE_REF");
    // a turn that cannot drive the desktop hears about neither
    expect(macUiRules(undefined, "/opt/homebrew/bin/agent-desktop")).toBe("");
  });

  test("a turn without the helper is not told about a door that is locked", () => {
    const p = buildSystemPrompt({ base: "p", botName: "Evie" });
    expect(p).not.toContain("Driving a desktop app");
    const q = buildSystemPrompt({ base: "p", botName: "Evie", macUiScript: "/x/mac-ui.js" });
    expect(q).toContain("Driving a desktop app");
  });
});
