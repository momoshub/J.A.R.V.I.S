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
      expect(p.allowedTools).toBeUndefined(); // no allow-list: everything is permitted
    }
  });

  test("some things are denied even at full access", () => {
    // --disallowedTools is honoured alongside --dangerously-skip-permissions,
    // so these are real denials rather than a request in the prompt
    for (const role of ["owner", "admin", "executer", "pal"] as const) {
      const denied = toolPolicyFor(role, opts).disallowedTools ?? [];
      // POSTING through a Slack connector arrives under the name of the human
      // who authorised it, not the bot's
      expect(denied).toContain("mcp__claude_ai_Slack__slack_send_message");
      expect(denied).toContain("mcp__claude_ai_Slack__slack_schedule_message");
      // and CloudWatch bills per GB scanned
      expect(denied).toContain("Bash(aws logs:*)");
      expect(denied).toContain("Bash(aws cloudwatch:*)");
    }
  });

  test("every role gets the Slack reader, including the sandboxed ones", () => {
    // a pal has no `curl` on purpose, so without this it cannot read a channel
    // the bot is sitting in - and it reported that as a Slack permission error
    const withReader = { ...opts, slackReadScript: "/bin/slack-read.sh" };
    for (const role of ["pal", "executer"] as const) {
      const allowed = toolPolicyFor(role, withReader).allowedTools ?? [];
      expect(allowed).toContain("Bash(/bin/slack-read.sh:*)");
    }
  });

  test("reading Slack is NOT denied - it impersonates nobody", () => {
    // the blanket ban refused the reads too, which was never its point: reading
    // is the only way to see a channel the bot was never invited to
    for (const role of ["owner", "admin", "executer", "pal"] as const) {
      const denied = toolPolicyFor(role, opts).disallowedTools ?? [];
      for (const read of [
        "mcp__claude_ai_Slack__slack_read_thread",
        "mcp__claude_ai_Slack__slack_read_channel",
        "mcp__claude_ai_Slack__slack_search_public",
      ]) {
        expect(denied).not.toContain(read);
      }
    }
  });

  test("pal is sandboxed, read-only, and cannot write", () => {
    const p = toolPolicyFor("pal", opts);
    expect(p.skipPermissions).toBe(false);
    expect(p.cwd).toBe("/scratch");
    expect(p.disallowedTools).toEqual(SANDBOX_DISALLOW);
    expect(p.allowedTools).not.toContain("Write");
  });

  test("pal can query grafana, read only", () => {
    const tools = toolPolicyFor("pal", opts).allowedTools ?? [];
    expect(tools).toContain("Bash(gcx logs query:*)");
    expect(tools).toContain("Bash(gcx logs labels:*)");
    expect(tools).toContain("Bash(gcx metrics query:*)");
    expect(tools).toContain("Bash(gcx datasources list:*)");
    expect(tools).toContain("Bash(gcx agent skills:*)"); // so it can load the investigation skill
    // `gcx logs adaptive` and `gcx dev` write, so the family is never granted wholesale
    expect(tools).not.toContain("Bash(gcx:*)");
    expect(tools).not.toContain("Bash(gcx logs:*)");
    expect(tools.some((t) => /gcx (dev|resources|setup|cloud|alert)/.test(t))).toBe(false);
  });

  test("a sandboxed role reads grafana through the helper, never `gcx api`", () => {
    const withHelper = { ...opts, grafanaGetScript: "/opt/jarvis/bin/grafana-get.sh" };
    for (const role of ["pal", "executer"] as const) {
      const tools = toolPolicyFor(role, withHelper).allowedTools ?? [];
      expect(tools).toContain("Bash(/opt/jarvis/bin/grafana-get.sh:*)");
      // `gcx api` can POST/PUT/DELETE, so it is never granted
      expect(tools).not.toContain("Bash(gcx api:*)");
    }
  });

  test("cloudwatch is denied to sandboxed roles - it bills per query", () => {
    for (const role of ["pal", "executer"] as const) {
      const denied = toolPolicyFor(role, opts).disallowedTools ?? [];
      expect(denied).toContain("Bash(aws logs:*)");
      expect(denied).toContain("Bash(aws cloudwatch:*)");
    }
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

  test("every sandboxed role may react and fetch a shared file, and nothing wider", () => {
    const withHelpers = { ...opts, fileScript: "/opt/jarvis/bin/slack-file.sh" };
    for (const role of ["pal", "executer"] as const) {
      const tools = toolPolicyFor(role, withHelpers).allowedTools ?? [];
      expect(tools).toContain(`Bash(${REACT}:*)`);
      expect(tools).toContain("Bash(/opt/jarvis/bin/slack-file.sh:*)");
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

describe("model per role", () => {
  test("a role can be put on a cheaper model", () => {
    const withModels = { ...opts, models: { pal: "haiku" } };
    expect(toolPolicyFor("pal", withModels).model).toBe("haiku");
    // everyone else stays on the adapter default
    expect(toolPolicyFor("executer", withModels).model).toBeUndefined();
    expect(toolPolicyFor("admin", withModels).model).toBeUndefined();
    expect(toolPolicyFor("owner", withModels).model).toBeUndefined();
  });

  test("any role may be pinned, not just pal", () => {
    const withModels = { ...opts, models: { executer: "sonnet", owner: "opus" } };
    expect(toolPolicyFor("executer", withModels).model).toBe("sonnet");
    expect(toolPolicyFor("owner", withModels).model).toBe("opus");
  });

  test("a channel model beats the role's, for every role", () => {
    const both = { ...opts, models: { pal: "haiku", owner: "opus" }, channelModel: "sonnet" };
    for (const role of ["pal", "executer", "admin", "owner"] as const) {
      expect(toolPolicyFor(role, both).model).toBe("sonnet");
    }
  });

  test("a blank channel model falls through to the role", () => {
    const p = toolPolicyFor("pal", { ...opts, models: { pal: "haiku" }, channelModel: "   " });
    expect(p.model).toBe("haiku");
  });

  test("no models configured means no override at all", () => {
    for (const role of ["pal", "executer", "admin", "owner"] as const) {
      expect(toolPolicyFor(role, opts).model).toBeUndefined();
    }
  });

  test("a cheaper model does not loosen the sandbox", () => {
    const p = toolPolicyFor("pal", { ...opts, models: { pal: "haiku" } });
    expect(p.skipPermissions).toBe(false);
    expect(p.cwd).toBe("/scratch");
    expect(p.disallowedTools).toEqual(SANDBOX_DISALLOW);
  });
});

