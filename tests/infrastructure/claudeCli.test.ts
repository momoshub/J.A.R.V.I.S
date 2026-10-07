import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeCliLlm, renderPrompt, summarizeTool } from "../../src/infrastructure/llm/claudeCli.ts";
import type { PromptMessage } from "../../src/domain/types.ts";
import type { LlmStreamEvent } from "../../src/application/ports.ts";

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

  test("this turn's command ticket travels in the environment, not the prompt", async () => {
    // a thread holds one long-lived session, so a ticket written into the prompt
    // is one the model eventually retypes from memory - dead by then, and
    // belonging to whoever was speaking at the time. An environment cannot be
    // stale: it was set when this turn began.
    const bin = fakeBin(
      `#!/usr/bin/env bash\ncat > /dev/null\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"[$JARVIS_RUN_TICKET]\\"}"`,
    );
    const llm = createClaudeCliLlm({ binPath: bin });

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

  test("summarizeTool renders a Bash command", () => {
    const out = summarizeTool("Bash", '{"command":"ls -la","description":"list"}');
    expect(out.title).toContain("ls -la");
    expect(out.details).toBe("ls -la");
  });

  test("summarizeTool keeps the whole Bash command even when the card is clipped", () => {
    // A heredoc body pushes the real gh call past the 200-char card title.
    const body = "x".repeat(400);
    const cmd = `cat > /tmp/r.md <<'EOF'\n${body}\nEOF\ngh pr review https://github.com/o/r/pull/1 --request-changes --body-file /tmp/r.md`;
    const out = summarizeTool("Bash", JSON.stringify({ command: cmd }));
    expect(out.title.length).toBeLessThanOrEqual(200);
    expect(out.title).not.toContain("gh pr review"); // clipped out of the card
    expect(out.command).toBe(cmd); // ... but preserved in full for matching
  });

  test("summarizeTool falls back to the tool name", () => {
    expect(summarizeTool("Read", '{"file_path":"/x"}').title).toBe("Read");
    expect(summarizeTool("Weird", "not json").title).toBe("Weird");
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
    expect(tools[0]!.title).toContain("ls");
    expect(tools[1]).toMatchObject({ id: "toolu_1", status: "complete" });
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
