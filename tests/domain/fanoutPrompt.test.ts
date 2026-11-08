import { describe, expect, test } from "bun:test";
import { FANOUT_MAX_WORKERS, fanoutPrompt } from "../../src/domain/fanoutPrompt.ts";

const ctx = { channelId: "C1", threadTs: "100.1", askedBy: "U1" };

describe("fanoutPrompt", () => {
  test("carries the job and reads the thread first", () => {
    const p = fanoutPrompt("fix the three flaky tests", "Bot", ctx);
    expect(p).toContain("fix the three flaky tests");
    expect(p).toContain("READ THAT THREAD FIRST");
    expect(p).toContain("100.1");
  });

  test("outside a thread it does not promise to read one", () => {
    const p = fanoutPrompt("q", "Bot", { ...ctx, threadTs: undefined });
    expect(p).not.toContain("READ THAT THREAD FIRST");
    expect(p).toContain("C1");
  });

  test("the worker count is capped and never padded", () => {
    const p = fanoutPrompt("q", "Bot", ctx);
    expect(p).toContain(`never more than ${FANOUT_MAX_WORKERS}`);
    expect(p).toContain("Never pad the count");
  });

  test("workers start on the worker model, also through the bare-shell fallback", () => {
    const p = fanoutPrompt("q", "Bot", ctx);
    expect(p).toContain('--agent claude --model "$BOT_WORKER_MODEL" --prompt');
    expect(p).toContain("claude --model $BOT_WORKER_MODEL --dangerously-skip-permissions");
  });

  test("terminal commands take a handle, not a worktree", () => {
    // `orca terminal wait --worktree` is refused with invalid_argument
    expect(fanoutPrompt("q", "Bot", ctx)).toContain("take `--terminal <handle>`, not `--worktree`");
  });

  test("a worker that never launched is checked for, not assumed", () => {
    // an oh-my-zsh update prompt ate the first keystroke of `claude ...` and
    // left a bare shell running `laude`
    const p = fanoutPrompt("q", "Bot", ctx);
    expect(p).toContain("confirm the agent actually launched");
    expect(p).toContain("Never present an idle worker as finished work");
  });

  test("nothing leaves the machine uninvited", () => {
    const p = fanoutPrompt("q", "Bot", ctx);
    expect(p).toContain("do not push, do not open a PR");
    expect(p).toContain("Do not push, open a PR, merge or delete anything");
  });
});
