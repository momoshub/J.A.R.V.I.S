import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeCliLlm, renderPrompt } from "../../src/infrastructure/llm/claudeCli.ts";
import type { PromptMessage } from "../../src/domain/types.ts";

describe("renderPrompt", () => {
  test("empty window renders nothing", () => {
    expect(renderPrompt([])).toBe("");
  });

  test("single message is passed through verbatim", () => {
    expect(renderPrompt([{ role: "user", content: "hello" }])).toBe("hello");
  });

  test("multi-turn renders labelled context plus the latest message", () => {
    const msgs: PromptMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey" },
      { role: "user", content: "how are you" },
    ];
    const out = renderPrompt(msgs);
    expect(out).toContain("User: hi");
    expect(out).toContain("E.V.: hey");
    expect(out).toContain("Respond to this newest message:");
    expect(out.trim().endsWith("how are you")).toBe(true);
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
