import { describe, expect, test } from "bun:test";
import {
  DB_MCP_SERVERS,
  EXECUTER_CODE_TOOLS,
  EXECUTER_DB_SERVERS,
  NO_TOOLS,
  PAL_TOOLS,
  SANDBOX_DISALLOW,
  toolPolicyFor,
} from "../../src/domain/toolPolicy.ts";

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

  test("an executer queries the read-only databases, a pal queries none", () => {
    const exe = toolPolicyFor("executer", opts);
    for (const db of ["mcp__pg-prod", "mcp__pg-prod-2", "mcp__pg-staging",
      "mcp__clickhouse-us-prod", "mcp__clickhouse-sg-prod"]) {
      expect(exe.allowedTools).toContain(db);
      expect(exe.disallowedTools).not.toContain(db);
    }
    // logs in as a write user, so it stays denied
    expect(exe.allowedTools).not.toContain("mcp__clickhouse-sg-stg");
    expect(exe.disallowedTools).toContain("mcp__clickhouse-sg-stg");
    // and an assigned list does not drop them
    const assigned = toolPolicyFor("executer", { ...opts, executerTools: ["Read"] }).allowedTools;
    expect(assigned).toContain("mcp__pg-prod");

    const pal = toolPolicyFor("pal", opts);
    for (const db of DB_MCP_SERVERS) expect(pal.disallowedTools).toContain(db);
    expect(DB_MCP_SERVERS).toContain("mcp__clickhouse-sg-stg");
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
    expect(tools).toEqual([
      "Read", "Bash(gh pr view:*)", ...EXECUTER_DB_SERVERS, ...EXECUTER_CODE_TOOLS,
      "Bash(screencapture:*)", "Bash(sips:*)", `Bash(${REACT}:*)`,
    ]);
  });

  test("an executer may run agent-desktop by its path, a pal may not", () => {
    const withBin = { ...opts, agentDesktop: "/opt/homebrew/bin/agent-desktop" };
    expect(toolPolicyFor("executer", withBin).allowedTools).toContain("Bash(/opt/homebrew/bin/agent-desktop:*)");
    expect(toolPolicyFor("pal", withBin).allowedTools).not.toContain("Bash(/opt/homebrew/bin/agent-desktop:*)");
  });

  test("with the lock wrapper, an executer reaches the drivers only through it", () => {
    const withLock = { ...opts, macUiScript: "/x/mac-ui.js", agentDesktop: "/opt/homebrew/bin/agent-desktop", desktopScript: "/x/desktop.ts" };
    const tools = toolPolicyFor("executer", withLock).allowedTools;
    expect(tools).toContain("Bash(/x/desktop.ts:*)");
    expect(tools).not.toContain("Bash(/x/mac-ui.js:*)");
    expect(tools).not.toContain("Bash(/opt/homebrew/bin/agent-desktop:*)");
    expect(toolPolicyFor("pal", withLock).allowedTools).not.toContain("Bash(/x/desktop.ts:*)");
  });

  test("an executer writes code and opens a PR, a pal does not", () => {
    const exe = toolPolicyFor("executer", { ...opts, protectedPaths: ["/opt/jarvis"] });
    for (const t of ["Write", "Edit", "Bash(git commit:*)", "Bash(git push:*)", "Bash(gh pr create:*)", "Bash(gh repo clone:*)"]) {
      expect(exe.allowedTools).toContain(t);
      expect(exe.disallowedTools).not.toContain(t);
    }
    // an assigned list does not drop them
    expect(toolPolicyFor("executer", { ...opts, executerTools: ["Read"] }).allowedTools).toContain("Write");
    // merging and force pushes stay human
    expect(exe.allowedTools).not.toContain("Bash(gh pr merge:*)");
    expect(exe.disallowedTools).toContain("Bash(git push --force:*)");
    expect(exe.disallowedTools).toContain("Bash(git push -f:*)");
    // the bot's own source and the CLI config are not a normal codebase
    expect(exe.disallowedTools).toContain("Edit(//opt/jarvis/**)");
    expect(exe.disallowedTools).toContain("Write(//opt/jarvis/**)");
    expect(exe.disallowedTools).toContain("Edit(~/.claude/**)");
    // secrets stay denied
    expect(exe.disallowedTools).toContain("Bash(aws secretsmanager:*)");

    const pal = toolPolicyFor("pal", opts);
    for (const t of ["Write", "Edit", "MultiEdit"]) expect(pal.disallowedTools).toContain(t);
    expect(pal.allowedTools).not.toContain("Bash(gh pr create:*)");
    expect(pal.allowedTools).not.toContain("Bash(git push:*)");
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


describe("database MCP servers", () => {
  test("a sandboxed role is DENIED them, not merely not granted them", () => {
    // absence from an allow-list is not a denial - the allow-list does not
    // restrict at all, measured against the CLI
    const pal = toolPolicyFor("pal", { sandboxCwd: "/tmp/box" });
    for (const server of DB_MCP_SERVERS) expect(pal.disallowedTools).toContain(server);
    // an executer is granted the read-only ones and denied the rest
    const exe = toolPolicyFor("executer", { sandboxCwd: "/tmp/box" });
    for (const server of DB_MCP_SERVERS.filter((s) => !EXECUTER_DB_SERVERS.includes(s))) {
      expect(exe.disallowedTools).toContain(server);
    }
  });

  test("full-access roles keep them - investigate is the reason they are here", () => {
    for (const role of ["admin", "owner"] as const) {
      const p = toolPolicyFor(role, { fullCwd: "/tmp/full" });
      for (const server of DB_MCP_SERVERS) {
        expect(p.disallowedTools ?? []).not.toContain(server);
      }
    }
  });

  test("a side question cannot run a production query", () => {
    for (const server of DB_MCP_SERVERS) expect(NO_TOOLS).toContain(server);
  });

  test("each entry names a whole server, because a bare prefix denies nothing", () => {
    // `--disallowedTools mcp__` was measured and the query still ran
    for (const server of DB_MCP_SERVERS) {
      expect(server.startsWith("mcp__")).toBe(true);
      expect(server).not.toBe("mcp__");
      expect(server.length).toBeGreaterThan("mcp__".length);
    }
  });
});
