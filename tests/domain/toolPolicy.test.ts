import { describe, expect, test } from "bun:test";
import { PAL_TOOLS, SANDBOX_DISALLOW, toolPolicyFor } from "../../src/domain/toolPolicy.ts";

const REACT = "/opt/jarvis/bin/slack-react.sh";
const opts = { fullCwd: "/work", sandboxCwd: "/scratch", reactScript: REACT };

describe("toolPolicyFor", () => {
  test("owner and admin run unsandboxed in the working directory", () => {
    for (const role of ["owner", "admin"] as const) {
      const p = toolPolicyFor(role, opts);
      expect(p.skipPermissions).toBe(true);
      expect(p.cwd).toBe("/work");
      expect(p.allowedTools).toBeUndefined(); // no list needed, nothing is denied
    }
  });

  test("pal is sandboxed, read-only, and cannot write", () => {
    const p = toolPolicyFor("pal", opts);
    expect(p.skipPermissions).toBe(false);
    expect(p.cwd).toBe("/scratch");
    expect(p.disallowedTools).toEqual(SANDBOX_DISALLOW);
    expect(p.allowedTools).not.toContain("Write");
  });

  test("pal can read github, notion and the web", () => {
    const tools = toolPolicyFor("pal", opts).allowedTools ?? [];
    // github
    expect(tools).toContain("Bash(gh pr view:*)");
    expect(tools).toContain("Bash(gh issue list:*)");
    expect(tools).toContain("Bash(gh repo view:*)");
    expect(tools).toContain("Bash(gh api:*)");
    // notion, read only - no create/update/delete tool is granted
    expect(tools).toContain("mcp__claude_ai_Notion__notion-search");
    expect(tools).toContain("mcp__claude_ai_Notion__notion-fetch");
    expect(tools.some((t) => /notion-(create|update|delete|move|duplicate)/.test(t))).toBe(false);
    // the web
    expect(tools).toContain("WebSearch");
    expect(tools).toContain("WebFetch");
  });

  test("every sandboxed role may react, through the helper and nothing wider", () => {
    for (const role of ["pal", "executer"] as const) {
      const tools = toolPolicyFor(role, opts).allowedTools ?? [];
      expect(tools).toContain(`Bash(${REACT}:*)`);
      // a general curl would be an outbound channel for the bot token
      expect(tools).not.toContain("Bash(curl:*)");
    }
  });

  test("an executer's assigned list still gets reactions appended", () => {
    const tools = toolPolicyFor("executer", { ...opts, executerTools: ["Read", "Bash(gh pr view:*)"] }).allowedTools;
    expect(tools).toEqual(["Read", "Bash(gh pr view:*)", `Bash(${REACT}:*)`]);
  });

  test("without a helper path nothing extra is granted", () => {
    const tools = toolPolicyFor("pal", { fullCwd: "/work", sandboxCwd: "/scratch" }).allowedTools;
    expect(tools).toEqual(PAL_TOOLS);
    expect(tools?.some((t) => t.includes("slack-react"))).toBe(false);
  });
});
