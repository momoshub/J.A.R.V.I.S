import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backgroundCutOffNotice,
  createClaudeCliLlm,
  isReactCall,
  payerOf,
  renderPrompt,
  summarizeTool,
  usageOf,
} from "../../src/infrastructure/llm/claudeCli.ts";
import type { PromptMessage } from "../../src/domain/types.ts";
import type { BillingContext, LlmStreamEvent, ToolTrace } from "../../src/application/ports.ts";

describe("renderPrompt", () => {
  test("empty window renders nothing", () => {
    expect(renderPrompt([])).toBe("");
  });

  test("single message asks for a reply and carries the sender tag", () => {
    const out = renderPrompt([{ role: "user", content: "hello", speakerId: "U1" }]);
    expect(out).toContain("hello");
    expect(out).toContain("(from <@U1>)");
  });

  test("multi-turn attributes speakers by tag and labels the bot's turns", () => {
    const msgs: PromptMessage[] = [
      { role: "user", content: "hi", speakerId: "U1" },
      { role: "assistant", content: "hey" },
      { role: "user", content: "how are you", speakerId: "U2" },
    ];
    const out = renderPrompt(msgs, "Evie");
    expect(out).toContain("<@U1>: hi");
    expect(out).toContain("Evie: hey");
    expect(out).toContain("Respond to this newest message (from <@U2>):");
    expect(out.trim().endsWith("how are you")).toBe(true);
  });

  test("defaults the assistant label when no name is given", () => {
    const out = renderPrompt(
      [
        { role: "user", content: "hi", speakerId: "U1" },
        { role: "assistant", content: "hey" },
        { role: "user", content: "yo", speakerId: "U1" },
      ],
    );
    expect(out).toContain("Assistant: hey");
  });

  test("falls back to User when a speaker id is missing", () => {
    const out = renderPrompt([
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ]);
    expect(out).toContain("User: a");
  });
});

// Fake `claude` binary so we can exercise spawn/parse without the real CLI.
const fakeBin = (script: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "ev-claude-"));
  const path = join(dir, "claude");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
};

describe("createClaudeCliLlm", () => {
  test("parses the result field from json output", async () => {
    const bin = fakeBin(
      `#!/usr/bin/env bash\ncat > /dev/null\necho '{"type":"result","subtype":"success","is_error":false,"result":"At your service."}'`,
    );
    const llm = createClaudeCliLlm({ binPath: bin });
    const out = await llm.complete({ system: "sys", messages: [{ role: "user", content: "hi" }] });
    expect(out).toBe("At your service.");
  });

  test("throws on an error result", async () => {
    const bin = fakeBin(
      `#!/usr/bin/env bash\ncat > /dev/null\necho '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}'`,
    );
    const llm = createClaudeCliLlm({ binPath: bin });
    await expect(
      llm.complete({ system: "sys", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/boom|error_during_execution/);
  });

  test("throws on a non-zero exit", async () => {
    const bin = fakeBin(`#!/usr/bin/env bash\ncat > /dev/null\necho 'nope' >&2\nexit 3`);
    const llm = createClaudeCliLlm({ binPath: bin });
    await expect(
      llm.complete({ system: "sys", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/exited with code 3/);
  });

  test("throws on non-json output", async () => {
    const bin = fakeBin(`#!/usr/bin/env bash\ncat > /dev/null\necho 'not json'`);
    const llm = createClaudeCliLlm({ binPath: bin });
    await expect(
      llm.complete({ system: "sys", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/non-JSON/);
  });

  test("a policy model overrides the adapter's", async () => {
    // the fake echoes its own argv, so we can see which --model was passed
    const bin = fakeBin(
      `#!/usr/bin/env bash\ncat > /dev/null\nARGS="$*"\nif [[ "$ARGS" == *"--model haiku"* ]]; then R="haiku"; else R="$ARGS"; fi\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"$R\\"}"`,
    );
    const llm = createClaudeCliLlm({ binPath: bin, model: "opus" });
    const out = await llm.complete({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      policy: { skipPermissions: true, model: "haiku" },
    });
    expect(out).toBe("haiku");
  });

  test("agent definitions go out as one --agents JSON argument, asked per turn", async () => {
    // the fake echoes the argument after --agents
    const bin = fakeBin(
      `#!/usr/bin/env bash\ncat > /dev/null\nR=none\nwhile [ $# -gt 0 ]; do if [ "$1" = "--agents" ]; then R=$(printf %s "$2" | base64 | tr -d '\\n'); fi; shift; done\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"$R\\"}"`,
    );
    let plan = "opus";
    const llm = createClaudeCliLlm({ binPath: bin, agents: () => ({ Plan: { description: "d", prompt: "p", model: plan } }) });
    const ask = async () =>
      JSON.parse(Buffer.from(await llm.complete({ system: "s", messages: [{ role: "user", content: "hi" }] }), "base64").toString());
    expect(await ask()).toEqual({ Plan: { description: "d", prompt: "p", model: "opus" } });
    plan = "sonnet";
    expect((await ask()).Plan.model).toBe("sonnet");

    expect(await createClaudeCliLlm({ binPath: bin }).complete({ system: "s", messages: [{ role: "user", content: "hi" }] })).toBe(
      "none",
    );
  });

  test("a named session passes its name to the CLI", async () => {
    // a thread's session is named after the thread, so another one can find it
    const bin = fakeBin(
      `#!/usr/bin/env bash\ncat > /dev/null\nARGS="$*"\nif [[ "$ARGS" == *"--name jarvis-C1-1.2"* ]]; then R="named"; else R="$ARGS"; fi\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"$R\\"}"`,
    );
    const llm = createClaudeCliLlm({ binPath: bin });
    const out = await llm.complete({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      session: { id: "abc", resume: true, name: "jarvis-C1-1.2" },
    });
    expect(out).toBe("named");
  });

  test("a denial still reaches the CLI at full access", async () => {
    // the bug: disallowedTools used to be passed only in the sandboxed branch,
    // so a full-access role could reach a tool it was merely asked to avoid
    const bin = fakeBin(
      `#!/usr/bin/env bash\ncat > /dev/null\nARGS="$*"\nif [[ "$ARGS" == *"--disallowedTools"* && "$ARGS" == *"--dangerously-skip-permissions"* ]]; then R="both"; else R="$ARGS"; fi\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"$R\\"}"`,
    );
    const llm = createClaudeCliLlm({ binPath: bin });
    const out = await llm.complete({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      policy: { skipPermissions: true, disallowedTools: ["mcp__claude_ai_Slack"] },
    });
    expect(out).toBe("both");
  });

  test("a caller's own token replaces the bot's in the spawned CLI", async () => {
    // the whole point of per-user tokens: the CLI honours CLAUDE_CODE_OAUTH_TOKEN
    // over whatever login the host holds, so the turn is billed to the caller
    const bin = fakeBin(
      `#!/usr/bin/env bash\ncat > /dev/null\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"$CLAUDE_CODE_OAUTH_TOKEN\\"}"`,
    );
    const llm = createClaudeCliLlm({ binPath: bin });
    // the bot's own credential is in the environment, as it is in production
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-bots-own";

    const mine = await llm.complete({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      oauthToken: "sk-ant-oat01-theirs",
    });
    // replaced, not merged: the bot's token is not in that child's environment at
    // all, so nothing the run spawns in turn can reach it either
    expect(mine).toBe("sk-ant-oat01-theirs");
    expect(mine).not.toContain("bots-own");

    // and without one the process keeps whatever the bot itself is running on
    const fallback = await llm.complete({ system: "s", messages: [{ role: "user", content: "hi" }] });
    expect(fallback).toBe("sk-ant-oat01-bots-own");
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  test("a connector task runs on the host login, with the bot's token removed", async () => {
    // a `claude setup-token` credential carries no claude.ai connector
    // authorisation - zero mcp__ tools under one - so the one task that needs a
    // connector has to run on the host session. Omitting the token is not
    // enough: the bot's own is in process.env and would still win.
    const bin = fakeBin(
      `#!/usr/bin/env bash\ncat > /dev/null\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"[$CLAUDE_CODE_OAUTH_TOKEN]\\"}"`,
    );
    const llm = createClaudeCliLlm({ binPath: bin });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-bots-own";

    const host = await llm.complete({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      useHostLogin: true,
    });
    expect(host).toBe("[]"); // nothing in the child's environment

    // and it wins over a caller's token too - a per-user token is also a setup
    // token, so it has no connectors either
    const overridden = await llm.complete({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      oauthToken: "sk-ant-oat01-theirs",
      useHostLogin: true,
    });
    expect(overridden).toBe("[]");
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  test("a bot turn loads no claude.ai connectors and none of the unauthenticated servers", async () => {
    // datadog and figma were unauthenticated, so the CLI injected a needs-auth
    // notice mid-turn and the model wrote it into a Slack reply. The env var
    // drops the claude.ai connectors; --strict-mcp-config with the host's own
    // servers minus the denylist drops the rest, and keeps notion/db servers.
    const dir = mkdtempSync(join(tmpdir(), "ev-claudejson-"));
    const claudeJsonPath = join(dir, "claude.json");
    writeFileSync(
      claudeJsonPath,
      JSON.stringify({ mcpServers: { figma: { type: "http" }, datadog: { type: "http" }, notion: { type: "http" }, "pg-prod": { command: "x" } } }),
    );
    // prints the env var, then the argument after --mcp-config, then whether --strict-mcp-config came after it
    const bin = fakeBin(
      `#!/usr/bin/env bash\ncat > /dev/null\nC=none; S=no\nwhile [ $# -gt 0 ]; do if [ "$1" = "--mcp-config" ]; then C=$(printf %s "$2" | base64 | tr -d '\\n'); fi; if [ "$1" = "--strict-mcp-config" ]; then S=yes; fi; shift; done\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"$ENABLE_CLAUDEAI_MCP_SERVERS $S $C\\"}"`,
    );
    const llm = createClaudeCliLlm({ binPath: bin, claudeJsonPath });
    const [flag, strict, cfg] = (await llm.complete({ system: "s", messages: [{ role: "user", content: "hi" }] })).split(" ");
    expect(flag).toBe("false");
    expect(strict).toBe("yes");
    expect(Object.keys(JSON.parse(Buffer.from(cfg!, "base64").toString()).mcpServers)).toEqual(["notion", "pg-prod"]);

    // a caller's own token is a bot turn too
    const own = await llm.complete({ system: "s", messages: [{ role: "user", content: "hi" }], oauthToken: "sk-ant-oat01-theirs" });
    expect(own.split(" ")[0]).toBe("false");
  });

  test("a host-login spawn keeps the account's connectors: no env var, no strict config", async () => {
    // read/ticket/note/close are the tasks that need them
    const dir = mkdtempSync(join(tmpdir(), "ev-claudejson-"));
    const claudeJsonPath = join(dir, "claude.json");
    writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: { notion: {} } }));
    const bin = fakeBin(
      `#!/usr/bin/env bash\ncat > /dev/null\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"[$ENABLE_CLAUDEAI_MCP_SERVERS][$*]\\"}"`,
    );
    const llm = createClaudeCliLlm({ binPath: bin, claudeJsonPath });
    const out = await llm.complete({ system: "s", messages: [{ role: "user", content: "hi" }], useHostLogin: true });
    expect(out.startsWith("[]")).toBe(true);
    expect(out).not.toContain("--strict-mcp-config");
    expect(out).not.toContain("--mcp-config");
  });

  test("an unreadable host config leaves MCP config alone instead of loading nothing", async () => {
    const bin = fakeBin(
      `#!/usr/bin/env bash\ncat > /dev/null\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"[$ENABLE_CLAUDEAI_MCP_SERVERS][$*]\\"}"`,
    );
    const llm = createClaudeCliLlm({ binPath: bin, claudeJsonPath: join(tmpdir(), "does-not-exist.json") });
    const out = await llm.complete({ system: "s", messages: [{ role: "user", content: "hi" }] });
    expect(out.startsWith("[false]")).toBe(true);
    expect(out).not.toContain("--strict-mcp-config");
  });

  test("this turn's command ticket travels in the environment, not the prompt", async () => {
    // a thread holds one long-lived session, so a ticket written into the prompt
    // is one the model eventually retypes from memory - dead by then, and
    // belonging to whoever was speaking at the time. An environment cannot be
    // stale: it was set when this turn began.
    const bin = fakeBin(
      `#!/usr/bin/env bash\ncat > /dev/null\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"[$JARVIS_RUN_TICKET]\\"}"`,
    );
    const llm = createClaudeCliLlm({ binPath: bin });
    // run from inside a turn (as Jarvis does before a restart), the suite
    // inherits that turn's ticket, which is not the "no ticket" case under test
    delete process.env.JARVIS_RUN_TICKET;

    const withTicket = await llm.complete({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      runTicket: "tkt-this-turn",
    });
    expect(withTicket).toBe("[tkt-this-turn]");

    // and a turn that may not run commands hands down nothing at all
    const without = await llm.complete({ system: "s", messages: [{ role: "user", content: "hi" }] });
    expect(without).toBe("[]");
  });

  test("every turn carries the bot's own Orca handle, never an inherited one", async () => {
    // a `claude -p` turn is no Orca pane, so `orca orchestration run-create`
    // refused it until the bot handed it a terminal of its own.
    const bin = fakeBin(
      `#!/usr/bin/env bash\ncat > /dev/null\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"[$ORCA_TERMINAL_HANDLE]\\"}"`,
    );
    // the pane that started the bot leaves its own handle in the environment
    const before = process.env.ORCA_TERMINAL_HANDLE;
    process.env.ORCA_TERMINAL_HANDLE = "term_someone-elses-pane";
    try {
      let handle: string | undefined = "term_own";
      const llm = createClaudeCliLlm({ binPath: bin, turnEnv: async () => ({ ORCA_TERMINAL_HANDLE: handle }) });

      expect(await llm.complete({ system: "s", messages: [{ role: "user", content: "hi" }] })).toBe("[term_own]");
      // Orca down: no handle at all, not the borrowed one
      handle = undefined;
      expect(await llm.complete({ system: "s", messages: [{ role: "user", content: "hi" }] })).toBe("[]");

      delete process.env.ORCA_TERMINAL_HANDLE;
      // a provider that throws costs the turn its handle, not the turn
      const broken = createClaudeCliLlm({
        binPath: bin,
        turnEnv: async () => {
          throw new Error("orca exploded");
        },
      });
      expect(await broken.complete({ system: "s", messages: [{ role: "user", content: "hi" }] })).toBe("[]");
    } finally {
      if (before === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
      else process.env.ORCA_TERMINAL_HANDLE = before;
    }
  });

  test("a turn is told which session it is, so it never mistakes itself for another writer", async () => {
    // a long turn listing processes found `claude -p --resume <id>` in its own
    // repo, called it a rogue builder, and blocked asking to kill it - itself.
    const bin = fakeBin(
      `#!/usr/bin/env bash\ncat > /dev/null\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"[$BOT_SESSION_ID]\\"}"`,
    );
    const llm = createClaudeCliLlm({ binPath: bin });
    delete process.env.BOT_SESSION_ID;

    const inSession = await llm.complete({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      session: { id: "11111111-2222-3333-4444-555555555555", resume: true },
    });
    expect(inSession).toBe("[11111111-2222-3333-4444-555555555555]");

    const oneShot = await llm.complete({ system: "s", messages: [{ role: "user", content: "hi" }] });
    expect(oneShot).toBe("[]");
  });

  test("summarizeTool titles a Bash step `Run: <emoji> <description>`, never the command", () => {
    const out = summarizeTool("Bash", '{"command":"ls -la","description":"List files in current directory"}');
    expect(out.title).toBe("Run: 🏃 List files in current directory");
    expect(out.details).toBeUndefined();
    expect(out.command).toBe("ls -la");
  });

  test("summarizeTool does not fall back to the raw command without a description", () => {
    const out = summarizeTool("Bash", '{"command":"curl -H secret https://x"}');
    expect(out.title).toBe("Run: 🏃 Running a command");
    expect(out.details).toBeUndefined();
    expect(out.command).toBe("curl -H secret https://x");
    expect(summarizeTool("Bash", '{"command":"ls","description":"  "}').title).toBe("Run: 🏃 Running a command");
  });

  test("summarizeTool points the card's details at the trace log line, never the command", () => {
    const spot = { file: "logs/threads/C1/1.2.jsonl", line: 7 };
    const out = summarizeTool("Bash", '{"command":"ls","description":"List files"}', spot);
    expect(out.details).toBe("log at: logs/threads/C1/1.2.jsonl - line 7");
    expect(out.details).not.toContain("ls -");
    expect(summarizeTool("Read", '{"file_path":"/x"}', spot).details).toBe("log at: logs/threads/C1/1.2.jsonl - line 7");
  });

  test("summarizeTool keeps the whole Bash command even when the description is clipped", () => {
    // A heredoc body pushes the real gh call far past any card length.
    const body = "x".repeat(400);
    const cmd = `cat > /tmp/r.md <<'EOF'\n${body}\nEOF\ngh pr review https://github.com/o/r/pull/1 --request-changes --body-file /tmp/r.md`;
    const out = summarizeTool("Bash", JSON.stringify({ command: cmd, description: "d".repeat(400) }));
    expect(out.title.length).toBeLessThanOrEqual(200);
    expect(out.command).toBe(cmd);
  });

  test("summarizeTool shortens the host's paths in a description", () => {
    const home = process.env.HOME ?? "/Users/x";
    const out = summarizeTool("Bash", JSON.stringify({ command: "x", description: `Search ${home}/Workspaces/acme-be` }));
    expect(out.title).toBe("Run: 🏃 Search $Workspaces/acme-be");
  });

  test("summarizeTool names each kind of step", () => {
    expect(summarizeTool("Read", '{"file_path":"/x"}')).toEqual({ title: "Tool: 📖 Reading a file" });
    expect(summarizeTool("Edit", '{"file_path":"/x"}').title).toBe("Tool: ✏️ Editing a file");
    expect(summarizeTool("WebSearch", '{"query":"q"}').title).toBe("Tool: 🌐 Searching the web");
    expect(summarizeTool("Agent", '{"description":"Review the diff","prompt":"p"}').title).toBe("Agent: 🧩 Review the diff");
    expect(summarizeTool("Agent", '{"description":"Try it","subagent_type":"fork"}').title).toBe("FAgent: 🍴 Try it");
    expect(summarizeTool("Task", '{"prompt":"p"}').title).toBe("Agent: 🧩 Running a helper agent");
    expect(summarizeTool("Skill", '{"skill":"jarvis-source"}').title).toBe("Skill: 📘 jarvis-source");
    expect(summarizeTool("Workflow", '{"script":"x"}').title).toBe("WAgent: 👷 Running a workflow");
    expect(summarizeTool("mcp__pg-prod__execute_sql", '{"sql":"select 1"}')).toEqual({
      title: "MCP: 🔌 pg-prod execute_sql",
    });
    expect(summarizeTool("mcp__claude_ai_Slack__slack_read_thread", "{}").title).toBe("MCP: 🔌 Slack slack_read_thread");
  });

  test("summarizeTool calls an Orca worker start a WAgent and keeps its command", () => {
    const cmd = "orca orchestration worker-start --spec x --agent claude --json";
    const out = summarizeTool("Bash", JSON.stringify({ command: cmd, description: "Start a reviewer worker" }));
    expect(out.title).toBe("WAgent: 👷 Start a reviewer worker");
    expect(out.command).toBe(cmd);
  });

  test("summarizeTool calls memory writes and reads Memory, and still keeps the command", () => {
    const cmd = "curl -s localhost:2002/api/learnings -d x";
    const out = summarizeTool("Bash", JSON.stringify({ command: cmd, description: "Save a learning" }));
    expect(out.title).toBe("Memory: 🧠 Save a learning");
    expect(out.command).toBe(cmd);
    expect(summarizeTool("Write", '{"file_path":"data/adapter-mirror/memory/NOTES.md"}').title).toBe("Memory: 🧠 Updating memory");
    expect(summarizeTool("Read", '{"file_path":"x/memory/NOTES.md"}').title).toBe("Memory: 🧠 Reading a memory note");
  });

  test("summarizeTool falls back to the tool name", () => {
    expect(summarizeTool("Weird", "not json").title).toBe("Tool: 🔧 Using Weird");
  });

  test("passes the rendered prompt to the binary on stdin", async () => {
    // The fake echoes back stdin inside the result so we can assert on it.
    const bin = fakeBin(
      `#!/usr/bin/env bash\nIN=$(cat)\nif [[ "$IN" == *"marker-xyz"* ]]; then R="seen"; else R="missing"; fi\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"$R\\"}"`,
    );
    const llm = createClaudeCliLlm({ binPath: bin });
    const out = await llm.complete({ system: "sys", messages: [{ role: "user", content: "marker-xyz" }] });
    expect(out).toBe("seen");
  });
});

// A fake `claude` that emits stream-json NDJSON events (built via JSON.stringify
// so there is no shell-escaping to get wrong).
const fakeStreamBin = (events: unknown[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "ev-claude-stream-"));
  const dataPath = join(dir, "events.ndjson");
  writeFileSync(dataPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const path = join(dir, "claude");
  writeFileSync(path, `#!/usr/bin/env bash\ncat > /dev/null\ncat ${dataPath}\n`);
  chmodSync(path, 0o755);
  return path;
};

const STREAM_EVENTS = [
  { type: "system", subtype: "init" },
  {
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Bash" } },
  },
  {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } },
  },
  { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: false }] } },
  { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } } },
  { type: "result", subtype: "success", is_error: false, result: "Hello world" },
];

describe("isReactCall", () => {
  test("only a Bash call that runs nothing but the react helper counts", () => {
    const cmd = (command: string) => JSON.stringify({ command });
    expect(isReactCall("Bash", cmd("/Users/kai/Workspaces/J.A.R.V.I.S./bin/slack-react.sh C1 1.1 fire"))).toBe(true);
    expect(isReactCall("Bash", cmd("bash bin/slack-react.sh C1 1.1 fire 2>&1"))).toBe(true);
    expect(isReactCall("Bash", cmd("bin/slack-react.sh C1 1.1 fire && bin/slack-react.sh C1 1.1 eyes"))).toBe(true);
    expect(isReactCall("Bash", cmd("ls"))).toBe(false);
    expect(isReactCall("Bash", cmd("bin/slack-react.sh C1 1.1 fire; rm x"))).toBe(false);
    expect(isReactCall("Bash", cmd("echo slack-react.sh"))).toBe(false);
    expect(isReactCall("Read", cmd("bin/slack-react.sh C1 1.1 fire"))).toBe(false);
    expect(isReactCall("Bash", "{broken")).toBe(false);
    expect(isReactCall("Bash", "")).toBe(false);
  });
});

describe("createClaudeCliLlm.stream", () => {
  test("forwards text deltas and tool events and returns the final text", async () => {
    const llm = createClaudeCliLlm({ binPath: fakeStreamBin(STREAM_EVENTS) });
    const events: LlmStreamEvent[] = [];
    const final = await llm.stream!(
      { system: "sys", messages: [{ role: "user", content: "hi" }] },
      (e) => events.push(e),
    );

    expect(final).toBe("Hello world");

    const texts = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta);
    expect(texts).toEqual(["Hello ", "world"]);

    const tools = events.filter((e) => e.type === "tool") as Array<
      Extract<LlmStreamEvent, { type: "tool" }>
    >;
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ id: "toolu_1", status: "in_progress" });
    expect(tools[0]!.title).toBe("Run: 🏃 Running a command");
    expect(tools[0]!.command).toContain("ls");
    expect(tools[1]).toMatchObject({ id: "toolu_1", status: "complete" });
  });

  test("a background agent waking the run again does not replace the answer", async () => {
    // the bug: the person's question was answered, then a background agent's
    // notification woke the CLI for another round, and only that round's CI
    // update reached the thread
    const events = [
      { type: "result", subtype: "success", is_error: false, result: "the answer to your question" },
      { type: "result", subtype: "success", is_error: false, result: "the PR is up" },
      { type: "result", subtype: "success", is_error: false, result: "CI is green" },
    ];
    const llm = createClaudeCliLlm({ binPath: fakeStreamBin(events) });
    const final = await llm.stream!({ system: "s", messages: [{ role: "user", content: "hi" }] }, () => {});
    expect(final).toBe("the answer to your question\n\nthe PR is up\n\nCI is green");
  });

  test("a round that repeats the last result is not said twice", async () => {
    const events = [
      { type: "result", subtype: "success", is_error: false, result: "done" },
      { type: "result", subtype: "success", is_error: false, result: " done " },
    ];
    const llm = createClaudeCliLlm({ binPath: fakeStreamBin(events) });
    const final = await llm.stream!({ system: "s", messages: [{ role: "user", content: "hi" }] }, () => {});
    expect(final).toBe("done");
  });

  test("falls back to streamed text if no result event arrives", async () => {
    const partial = STREAM_EVENTS.filter((e) => (e as { type: string }).type !== "result");
    const llm = createClaudeCliLlm({ binPath: fakeStreamBin(partial) });
    const final = await llm.stream!({ system: "sys", messages: [{ role: "user", content: "hi" }] }, () => {});
    expect(final).toBe("Hello world");
  });

  test("separates consecutive text blocks so they do not run together", async () => {
    // Two text blocks with a tool call between them: the deltas used to be
    // concatenated, turning "...command." + "on it" into "...command.on it".
    const events = [
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "first." } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "second" } } },
    ];
    const llm = createClaudeCliLlm({ binPath: fakeStreamBin(events) });
    const deltas: string[] = [];
    const final = await llm.stream!({ system: "s", messages: [{ role: "user", content: "hi" }] }, (e) => {
      if (e.type === "text") deltas.push(e.delta);
    });
    expect(deltas.join("")).toBe("first.\n\nsecond");
    expect(final).toBe("first.\n\nsecond");
  });

  test("text the model writes before a tool call never reaches the reply", async () => {
    // the leak: "Partial work exists. Resume the agent." was the model talking
    // to itself before a SendMessage call, and it went out at the top of the reply
    const se = (event: unknown) => ({ type: "stream_event", event });
    const events = [
      se({ type: "message_start" }),
      se({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial work exists. Resume the agent." } }),
      se({ type: "content_block_stop", index: 0 }),
      se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Bash" } }),
      se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }),
      se({ type: "content_block_stop", index: 1 }),
      se({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      se({ type: "message_stop" }),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } },
      se({ type: "message_start" }),
      se({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sorry, " } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "resumed it" } }),
      se({ type: "content_block_stop", index: 0 }),
      se({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      se({ type: "message_stop" }),
    ];
    const llm = createClaudeCliLlm({ binPath: fakeStreamBin(events) });
    const deltas: string[] = [];
    const final = await llm.stream!({ system: "s", messages: [{ role: "user", content: "hi" }] }, (e) => {
      if (e.type === "text") deltas.push(e.delta);
    });
    expect(deltas).toEqual(["sorry, ", "resumed it"]);
    expect(final).toBe("sorry, resumed it");
  });

  test("an answer written before a closing tool call is kept when nothing follows it", async () => {
    const se = (event: unknown) => ({ type: "stream_event", event });
    const events = [
      se({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "here is the answer" } }),
      se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Bash" } }),
      se({ type: "content_block_stop", index: 1 }),
      se({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } },
      se({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ];
    const llm = createClaudeCliLlm({ binPath: fakeStreamBin(events) });
    const deltas: string[] = [];
    const final = await llm.stream!({ system: "s", messages: [{ role: "user", content: "hi" }] }, (e) => {
      if (e.type === "text") deltas.push(e.delta);
    });
    expect(deltas.join("")).toBe("here is the answer");
    expect(final).toBe("here is the answer");
  });

  test("an answer written right before a closing react call is streamed, and survives a later meta line", async () => {
    // the incident: full Slack answer + slack-react.sh in one message, then a
    // short meta line after the tool result. The answer was held, the meta line
    // went out alone.
    const se = (event: unknown) => ({ type: "stream_event", event });
    const react = JSON.stringify({ command: "/Users/kai/Workspaces/J.A.R.V.I.S./bin/slack-react.sh C1 1700000000.0001 fire" });
    const events = [
      se({ type: "message_start" }),
      se({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "the full answer" } }),
      se({ type: "content_block_stop", index: 0 }),
      se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Bash" } }),
      se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: react.slice(0, 20) } }),
      se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: react.slice(20) } }),
      se({ type: "content_block_stop", index: 1 }),
      se({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      se({ type: "message_stop" }),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } },
      se({ type: "message_start" }),
      se({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "reacted." } }),
      se({ type: "content_block_stop", index: 0 }),
      se({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      se({ type: "message_stop" }),
      { type: "result", subtype: "success", result: "reacted." },
    ];
    const llm = createClaudeCliLlm({ binPath: fakeStreamBin(events) });
    const deltas: string[] = [];
    const final = await llm.stream!({ system: "s", messages: [{ role: "user", content: "hi" }] }, (e) => {
      if (e.type === "text") deltas.push(e.delta);
    });
    expect(deltas.join("")).toBe("the full answer\n\nreacted.");
    // finalText only holds the last round; the returned text carries the answer too
    expect(final).toBe("the full answer\n\nreacted.");
  });

  test("text before a react call that is chained with a real command is still dropped", async () => {
    const se = (event: unknown) => ({ type: "stream_event", event });
    const cmd = JSON.stringify({ command: "slack-react.sh C1 1.1 fire && rm -rf /tmp/x" });
    const events = [
      se({ type: "message_start" }),
      se({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "let me clean up first" } }),
      se({ type: "content_block_stop", index: 0 }),
      se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Bash" } }),
      se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: cmd } }),
      se({ type: "content_block_stop", index: 1 }),
      se({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      se({ type: "message_stop" }),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } },
      se({ type: "message_start" }),
      se({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }),
      se({ type: "content_block_stop", index: 0 }),
      se({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      se({ type: "message_stop" }),
    ];
    const llm = createClaudeCliLlm({ binPath: fakeStreamBin(events) });
    const deltas: string[] = [];
    await llm.stream!({ system: "s", messages: [{ role: "user", content: "hi" }] }, (e) => {
      if (e.type === "text") deltas.push(e.delta);
    });
    expect(deltas).toEqual(["done"]);
  });

  test("a run killed after it spoke is reported as aborted, not as an answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ev-claude-abort-"));
    const path = join(dir, "claude");
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "halfway there" } },
    });
    writeFileSync(path, `#!/usr/bin/env bash\ncat > /dev/null\necho '${line}'\nexit 143\n`);
    chmodSync(path, 0o755);

    const llm = createClaudeCliLlm({ binPath: path });
    const seen: LlmStreamEvent[] = [];
    const out = await llm.stream!({ system: "s", messages: [{ role: "user", content: "hi" }] }, (e) => seen.push(e));
    expect(out).toBe("halfway there"); // the fragment is still handed back
    const aborted = seen.find((e) => e.type === "aborted");
    expect(aborted).toMatchObject({ type: "aborted", reason: "it ran out of time" });
  });

  test("plumbing tools and results with no card of ours draw nothing", async () => {
    const events = [
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "ToolSearch" } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } },
      // a subagent's own step: a result for a call we never saw start
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "sub_1", is_error: false }] } },
      { type: "result", subtype: "success", is_error: false, result: "done" },
    ];
    const llm = createClaudeCliLlm({ binPath: fakeStreamBin(events) });
    const seen: LlmStreamEvent[] = [];
    await llm.stream!({ system: "s", messages: [{ role: "user", content: "hi" }] }, (e) => seen.push(e));
    expect(seen.filter((e) => e.type === "tool")).toEqual([]);
  });

  test("maps a failed tool_result to status error", async () => {
    const events = [
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t9", name: "Bash" } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t9", is_error: true }] } },
      { type: "result", subtype: "success", is_error: false, result: "done" },
    ];
    const llm = createClaudeCliLlm({ binPath: fakeStreamBin(events) });
    const seen: LlmStreamEvent[] = [];
    await llm.stream!({ system: "s", messages: [{ role: "user", content: "hi" }] }, (e) => seen.push(e));
    const errored = seen.find((e) => e.type === "tool" && e.status === "error");
    expect(errored).toBeDefined();
  });
});

describe("tracing every tool call in full", () => {
  test("calls and results reach the trace with the run's thread, plumbing and subagents included", async () => {
    const events = [
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Bash" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls -la /tmp"}' } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "a\nb" }] } },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t2", name: "ToolSearch" } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      {
        type: "assistant",
        parent_tool_use_id: "task_1",
        message: { content: [{ type: "tool_use", id: "s1", name: "Read", input: { file_path: "/x" } }] },
      },
      {
        type: "user",
        parent_tool_use_id: "task_1",
        message: { content: [{ type: "tool_result", tool_use_id: "s1", is_error: true, content: [{ type: "text", text: "nope" }] }] },
      },
      { type: "result", subtype: "success", is_error: false, result: "done" },
    ];
    const traces: { trace: ToolTrace; bill: BillingContext | undefined }[] = [];
    const llm = createClaudeCliLlm({ binPath: fakeStreamBin(events), onToolTrace: (trace, bill) => void traces.push({ trace, bill }) });
    const bill = { actor: "U1", kind: "chat", channel: "C1", threadTs: "111.1" };
    await llm.stream!({ system: "s", messages: [{ role: "user", content: "hi" }], bill }, () => {});
    expect(traces.map((t) => t.trace)).toEqual([
      { kind: "call", id: "t1", name: "Bash", input: '{"command":"ls -la /tmp"}' },
      { kind: "result", id: "t1", isError: false, output: "a\nb" },
      { kind: "call", id: "t2", name: "ToolSearch", input: "" },
      { kind: "call", id: "s1", name: "Read", input: '{"file_path":"/x"}', parent: "task_1" },
      { kind: "result", id: "s1", isError: true, output: "nope", parent: "task_1" },
    ]);
    expect(traces.every((t) => t.bill === bill)).toBe(true);
  });

  test("a one-shot complete is traced too, and keeps complete's contract", async () => {
    const events = [
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Bash" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"date"}' } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "Thu" }] } },
      { type: "result", subtype: "success", is_error: false, result: "  it is Thursday  " },
    ];
    const traces: ToolTrace[] = [];
    const llm = createClaudeCliLlm({ binPath: fakeStreamBin(events), onToolTrace: (t) => void traces.push(t) });
    expect(await llm.complete({ system: "s", messages: [{ role: "user", content: "day?" }] })).toBe("it is Thursday");
    expect(traces.map((t) => t.kind)).toEqual(["call", "result"]);

    const failed = createClaudeCliLlm({
      binPath: fakeStreamBin([{ type: "result", subtype: "error_max_turns", is_error: true, result: "gave up" }]),
      onToolTrace: () => {},
    });
    await expect(failed.complete({ system: "s", messages: [{ role: "user", content: "x" }] })).rejects.toThrow(
      "claude CLI error (error_max_turns): gave up",
    );
  });

  test("a trace sink that throws does not break the run", async () => {
    const events = [
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Bash" } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "result", subtype: "success", is_error: false, result: "done" },
    ];
    const llm = createClaudeCliLlm({
      binPath: fakeStreamBin(events),
      onToolTrace: () => {
        throw new Error("disk full");
      },
    });
    expect(await llm.stream!({ system: "s", messages: [{ role: "user", content: "hi" }] }, () => {})).toBe("done");
  });
});

describe("recording what a run cost", () => {
  const RESULT_LINE =
    '{"type":"result","subtype":"success","is_error":false,"result":"done",' +
    '"total_cost_usd":0.5,"duration_ms":1234,' +
    '"usage":{"input_tokens":3,"output_tokens":7,"cache_read_input_tokens":11,"cache_creation_input_tokens":13},' +
    '"modelUsage":{"claude-opus-5-5":{"costUSD":0.5}}}';

  test("a completed run reports itself, with whose turn it was", async () => {
    const bin = fakeBin(`#!/usr/bin/env bash\ncat > /dev/null\necho '${RESULT_LINE}'`);
    const seen: { usage: unknown; payer: string; bill: unknown }[] = [];
    const llm = createClaudeCliLlm({
      binPath: bin,
      onUsage: (usage, payer, bill) => seen.push({ usage, payer, bill }),
    });
    await llm.complete({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      bill: { actor: "U1", kind: "review", channel: "C9" },
      oauthToken: "sk-ant-oat01-x",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.payer).toBe("caller");
    expect(seen[0]?.bill).toEqual({ actor: "U1", kind: "review", channel: "C9" });
    expect((seen[0]?.usage as { costUsd: number }).costUsd).toBe(0.5);
  });

  test("a recorder that throws never takes the turn down with it", async () => {
    const bin = fakeBin(`#!/usr/bin/env bash\ncat > /dev/null\necho '${RESULT_LINE}'`);
    const llm = createClaudeCliLlm({
      binPath: bin,
      onUsage: () => {
        throw new Error("the accountant exploded");
      },
    });
    const out = await llm.complete({ system: "sys", messages: [{ role: "user", content: "hi" }] });
    expect(out).toBe("done");
  });

  test("the caller hears the run's usage too, one-shot or traced", async () => {
    const bin = fakeBin(`#!/usr/bin/env bash\ncat > /dev/null\necho '${RESULT_LINE}'`);
    const heard: unknown[] = [];
    await createClaudeCliLlm({ binPath: bin }).complete({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      onUsage: (u) => heard.push(u),
    });
    await createClaudeCliLlm({ binPath: bin, onToolTrace: () => {} }).complete({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      onUsage: (u) => heard.push(u),
    });
    const expected = {
      model: "claude-opus-5-5",
      inputTokens: 3,
      outputTokens: 7,
      cacheReadTokens: 11,
      cacheWriteTokens: 13,
      costUsd: 0.5,
      durationMs: 1234,
    };
    expect(heard).toEqual([expected, expected]);
  });

  test("a caller's usage hook that throws never takes the turn down with it", async () => {
    const bin = fakeBin(`#!/usr/bin/env bash\ncat > /dev/null\necho '${RESULT_LINE}'`);
    const out = await createClaudeCliLlm({ binPath: bin }).complete({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      onUsage: () => {
        throw new Error("boom");
      },
    });
    expect(out).toBe("done");
  });
});

describe("usageOf", () => {
  /**
   * The real shape, captured from `claude -p --output-format stream-json`
   * rather than guessed at: that is the only way to know `total_cost_usd` is
   * top level while the token counts sit under `usage`, and that the model
   * that actually served the run is the single key of `modelUsage`.
   */
  const REAL_RESULT = {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 2557,
    duration_api_ms: 2219,
    num_turns: 1,
    total_cost_usd: 0.119019,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 14216,
      cache_read_input_tokens: 10815,
      output_tokens: 156,
    },
    modelUsage: { "claude-opus-5-5": { costUSD: 0.119019 } },
    result: "hi",
  };

  test("reads what the run actually cost", () => {
    expect(usageOf(REAL_RESULT)).toEqual({
      model: "claude-opus-5-5",
      inputTokens: 2,
      outputTokens: 156,
      cacheReadTokens: 10815,
      cacheWriteTokens: 14216,
      costUsd: 0.119019,
      durationMs: 2557,
    });
  });

  test("a line with no usage on it is not a run worth recording", () => {
    expect(usageOf({ type: "result", result: "hi" })).toBeUndefined();
  });

  test("missing numbers are zero, never NaN - a NaN would poison every total", () => {
    const u = usageOf({ total_cost_usd: 1, usage: {} });
    expect(u?.inputTokens).toBe(0);
    expect(u?.model).toBe("");
    expect(u?.costUsd).toBe(1);
  });
});

describe("payerOf", () => {
  test("whoever's credential carried it", () => {
    expect(payerOf("sk-ant-oat01-x", false)).toBe("caller");
    expect(payerOf(undefined, true)).toBe("host");
    expect(payerOf(undefined, false)).toBe("bot");
    // the caller's token replaces the bot's in the spawn env, so it wins
    expect(payerOf("sk-ant-oat01-x", true)).toBe("caller");
  });
});

describe("background work cut off when the run ends", () => {
  const text = (t: string) => ({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } },
  });
  const tasks = (list: Array<{ task_id: string; description: string }>) => ({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: list.map((t) => ({ ...t, task_type: "local_agent" })),
  });

  test("a job still running when the CLI exits is named in the reply, not dropped", async () => {
    const llm = createClaudeCliLlm({
      binPath: fakeStreamBin([
        tasks([{ task_id: "a1", description: "Build scheduled reports backend" }]),
        text("started on the backend"),
        { type: "result", subtype: "success", is_error: false, result: "started on the backend" },
      ]),
    });
    const deltas: string[] = [];
    const out = await llm.stream!({ system: "s", messages: [{ role: "user", content: "hi" }] }, (e) => {
      if (e.type === "text") deltas.push(e.delta);
    });
    expect(out).toStartWith("started on the backend\n\n");
    expect(out).toContain("`Build scheduled reports backend`");
    expect(out).toContain("stopped before finishing");
    // Streamed too, so an open message shows it without waiting for a rewrite.
    expect(deltas.join("")).toBe(out);
  });

  test("jobs that finished before the exit say nothing", async () => {
    const llm = createClaudeCliLlm({
      binPath: fakeStreamBin([
        tasks([{ task_id: "b1", description: "sleep 5" }]),
        text("done"),
        { type: "result", subtype: "success", is_error: false, result: "done" },
        tasks([]),
      ]),
    });
    const out = await llm.stream!({ system: "s", messages: [{ role: "user", content: "hi" }] }, () => {});
    expect(out).toBe("done");
  });

  test("the notice names every job left", () => {
    expect(backgroundCutOffNotice(["one", "two"])).toContain("2 background jobs were still going");
    expect(backgroundCutOffNotice(["one"])).toContain("a background job was still going");
  });
});

describe("createClaudeCliLlm timeout", () => {
  // A CLI stuck inside a tool call shrugs off SIGTERM, and Bun's own spawn
  // timeout sends nothing else. So a run past its limit simply kept going: a
  // background investigate never settled and never reported to its thread.
  test("a run past its timeout is stopped, even when the CLI ignores SIGTERM", async () => {
    const bin = fakeBin(`#!/usr/bin/env bash\ncat > /dev/null\nexec bash -c "trap '' TERM; while true; do sleep 1; done"\n`);
    const llm = createClaudeCliLlm({ binPath: bin, timeoutMs: 2_000 });
    const started = Date.now();
    await expect(llm.stream!({ system: "s", messages: [{ role: "user", content: "hi" }] }, () => {})).rejects.toThrow(
      /exited with code/,
    );
    expect(Date.now() - started).toBeLessThan(12_000);
  }, 20_000);
});
