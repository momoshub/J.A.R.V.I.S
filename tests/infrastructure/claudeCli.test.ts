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
