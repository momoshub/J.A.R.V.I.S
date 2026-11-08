import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackgroundAgents, type CommandOutcome } from "../../src/infrastructure/llm/backgroundAgents.ts";

const dir = mkdtempSync(join(tmpdir(), "bg-agents-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const bash = (command: string, output: string, actor: string): string => {
  const id = `toolu_${++n}`;
  return [
    JSON.stringify({ actor, run: "chat", kind: "call", id, name: "Bash", input: JSON.stringify({ command }) }),
    JSON.stringify({ actor, run: "chat", kind: "result", id, isError: false, output }),
  ].join("\n");
};

const writeTrace = (channel: string, threadTs: string, lines: string[]): void => {
  mkdirSync(join(dir, channel), { recursive: true });
  writeFileSync(join(dir, channel, `${threadTs}.jsonl`), `${lines.join("\n")}\n`);
};

const AGENTS = JSON.stringify([
  { id: "aaaaaaaa", kind: "background", state: "working" },
  { id: "bbbbbbbb", kind: "background", state: "done" },
  { id: "cccccccc", kind: "background", state: "working" },
  { id: "eeeeeeee", kind: "interactive", status: "busy" },
]);

/** A fake CLI: answers by command, records every call. */
const fakeRun = (overrides: Record<string, CommandOutcome> = {}) => {
  const calls: string[] = [];
  const run = async (cmd: readonly string[]): Promise<CommandOutcome> => {
    const line = cmd.join(" ");
    calls.push(line);
    if (overrides[line]) return overrides[line];
    if (line === "claude agents --json") return { code: 0, stdout: AGENTS, stderr: "" };
    if (line.includes("worker-show --dispatch ctx_a1b2c3"))
      return { code: 0, stdout: '{"ok":true,"result":{"state":"dispatched","stage":"running","liveness":"alive"}}', stderr: "" };
    if (line.includes("worker-show"))
      return { code: 0, stdout: '{"ok":true,"result":{"state":"succeeded","stage":"settled","liveness":"exited"}}', stderr: "" };
    return { code: 0, stdout: "stopped", stderr: "" };
  };
  return { run, calls };
};

describe("createBackgroundAgents", () => {
  writeTrace("C1", "100.1", [
    bash("claude --bg one", "backgrounded · aaaaaaaa", "U-me"),
    bash("claude --bg two", "backgrounded · bbbbbbbb", "U-me"),
    bash("claude --bg three", "backgrounded · cccccccc", "U-other"),
    bash("claude --bg four", "backgrounded · eeeeeeee", "U-me"),
    bash("orca orchestration worker-start --spec x --json", '{"ok":true,"result":{"dispatchId":"ctx_a1b2c3"}}', "U-me"),
    bash("orca orchestration worker-start --spec y --json", '{"ok":true,"result":{"dispatchId":"ctx_0d0d0d"}}', "U-me"),
  ]);
  // Another thread's launch: never reached from C1:100.1.
  writeTrace("C1", "200.2", [bash("claude --bg theirs", "backgrounded · dddddddd", "U-me")]);

  test("stops this thread's live launches through each CLI, and only those", async () => {
    const { run, calls } = fakeRun();
    const agents = createBackgroundAgents({ traceDir: dir, run });
    const out = await agents.stopForThread({ channelId: "C1", threadTs: "100.1", actor: "U-me", mayStopOthers: false });

    expect(out.stopped.map((l) => l.id)).toEqual(["aaaaaaaa", "ctx_a1b2c3"]);
    expect(out.notYours.map((l) => l.id)).toEqual(["cccccccc"]);
    expect(calls).toContain("claude stop aaaaaaaa");
    expect(calls).toContain("orca orchestration worker-stop --dispatch ctx_a1b2c3 --json");
    // finished, interactive, someone else's, another thread's, an old worker
    for (const id of ["bbbbbbbb", "eeeeeeee", "cccccccc", "dddddddd", "ctx_0d0d0d"]) {
      expect(calls.some((c) => c.includes("stop") && c.includes(id))).toBe(false);
    }
  });

  test("an admin stops everyone's", async () => {
    const { run } = fakeRun();
    const agents = createBackgroundAgents({ traceDir: dir, run });
    const out = await agents.stopForThread({ channelId: "C1", threadTs: "100.1", actor: "U-admin", mayStopOthers: true });
    expect(out.stopped.map((l) => l.id).sort()).toEqual(["aaaaaaaa", "cccccccc", "ctx_a1b2c3"]);
    expect(out.notYours).toEqual([]);
  });

  test("a stop the CLI refuses is reported, not swallowed", async () => {
    const { run } = fakeRun({ "claude stop aaaaaaaa": { code: 1, stdout: "", stderr: "No job matching 'aaaaaaaa'.\nmore" } });
    const agents = createBackgroundAgents({ traceDir: dir, run });
    const out = await agents.stopForThread({ channelId: "C1", threadTs: "100.1", actor: "U-me", mayStopOthers: false });
    expect(out.failed).toEqual([{ kind: "claude-bg", id: "aaaaaaaa", actor: "U-me", reason: "No job matching 'aaaaaaaa'." }]);
  });

  test("no trace runs nothing", async () => {
    const { run, calls } = fakeRun();
    const none = await createBackgroundAgents({ traceDir: dir, run }).stopForThread({
      channelId: "C9",
      threadTs: "1.1",
      actor: "U-me",
      mayStopOthers: true,
    });
    expect(none).toEqual({ stopped: [], failed: [], notYours: [], unchecked: [] });
    expect(calls).toEqual([]);
  });

  test("a CLI that will not answer is reported as unchecked, never as nothing to stop", async () => {
    const broken = fakeRun({
      "claude agents --json": { code: -1, stdout: "", stderr: "not found" },
      "orca orchestration worker-show --dispatch ctx_a1b2c3 --json": { code: 1, stdout: "", stderr: "runtime unavailable" },
    });
    const out = await createBackgroundAgents({ traceDir: dir, run: broken.run }).stopForThread({
      channelId: "C1",
      threadTs: "100.1",
      actor: "U-me",
      mayStopOthers: false,
    });
    expect(out.stopped).toEqual([]);
    expect(broken.calls.some((c) => c.includes(" stop"))).toBe(false);
    // Only the requester's own: someone else's unchecked launch is not theirs to hear about.
    expect(out.unchecked.map((l) => l.id)).toEqual(["aaaaaaaa", "bbbbbbbb", "eeeeeeee", "ctx_a1b2c3"]);
    expect(out.unchecked[0]?.reason).toBe("`claude agents` failed: not found");
    expect(out.unchecked[3]?.reason).toBe("`worker-show` failed: runtime unavailable");
  });

  test("a dispatch Orca no longer knows is gone, not unchecked", async () => {
    const { run } = fakeRun({
      "orca orchestration worker-show --dispatch ctx_0d0d0d --json": {
        code: 1,
        stdout: '{"ok":false,"error":{"code":"dispatch_not_found","message":"Worker Dispatch ctx_0d0d0d was not found."}}',
        stderr: "error: dispatch_not_found",
      },
    });
    const out = await createBackgroundAgents({ traceDir: dir, run }).stopForThread({
      channelId: "C1",
      threadTs: "100.1",
      actor: "U-me",
      mayStopOthers: false,
    });
    expect(out.unchecked).toEqual([]);
  });
});
