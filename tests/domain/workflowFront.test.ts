import { describe, expect, test } from "bun:test";
import {
  buildDigest,
  callSummary,
  createSteerFilter,
  DIGEST_CALLS,
  frontKeyOf,
  keepReplies,
  parseSteers,
  steeredMessage,
  WORKER_REPLIES_KEPT,
  type DigestCall,
} from "../../src/domain/workflowFront.ts";
import { frontPrompt, workflowPrompt } from "../../src/domain/workflowPrompt.ts";

const MIN = 60_000;

describe("parseSteers", () => {
  test("steer lines are taken out and returned in order", () => {
    const out = parseSteers("Got it, passing that on.\n[steer] use the dark theme\n[STEER]  skip the footer  ");
    expect(out.text).toBe("Got it, passing that on.");
    expect(out.steers).toEqual(["use the dark theme", "skip the footer"]);
  });

  test("tolerates bullets, code and emphasis around the marker", () => {
    for (const line of ["- [steer] x", "`[steer] x`", "**[steer]** x", "  > [steer] x"]) {
      expect(parseSteers(`ok\n${line}`)).toEqual({ text: "ok", steers: ["x"] });
    }
  });

  test("no steer, text untouched; an empty steer is dropped", () => {
    expect(parseSteers("it is on step 4, running tests")).toEqual({ text: "it is on step 4, running tests", steers: [] });
    expect(parseSteers("ok\n[steer]")).toEqual({ text: "ok", steers: [] });
  });

  test("a mention of the marker inside a sentence is not a steer", () => {
    expect(parseSteers("I add [steer] lines when needed").steers).toEqual([]);
  });
});

describe("createSteerFilter", () => {
  const run = (deltas: string[]): string => {
    const f = createSteerFilter();
    return deltas.map((d) => f.push(d)).join("") + f.flush();
  };

  test("a steer line split across deltas never shows", () => {
    expect(run(["On it.\n[st", "eer] use the da", "rk theme\nWill do."])).toBe("On it.\nWill do.");
    expect(run(["[steer] a\n", "[steer] b"])).toBe("");
  });

  test("ordinary text passes straight through, including a lone bracket", () => {
    expect(run(["status: [", "2/5] done\n", "next: tests"])).toBe("status: [2/5] done\nnext: tests");
    expect(run(["- item\n", "  [s", "ee also]"])).toBe("- item\n  [see also]");
  });

  test("a held fragment is released by flush", () => {
    const f = createSteerFilter();
    expect(f.push("hello\n[ste")).toBe("hello\n");
    expect(f.flush()).toBe("[ste");
    expect(f.push("p up")).toBe("p up");
  });
});

describe("buildDigest", () => {
  const now = 100 * MIN;
  const calls: DigestCall[] = Array.from({ length: 20 }, (_, i) => ({
    at: new Date(now - (20 - i) * MIN).toISOString(),
    name: "Bash",
    input: JSON.stringify({ command: `npm test -- part ${i} ${"x".repeat(300)}` }),
    isError: i === 19,
  }));

  test("says what the worker is doing, what it said and what it ran, kept small", () => {
    const d = buildDigest({
      now,
      worker: { state: "running", since: now - 4 * MIN },
      turns: 7,
      autoTurns: 3,
      steers: [{ by: "U1", text: "use the dark theme", at: now }],
      replies: [{ text: "opened the PR", at: now - 6 * MIN }],
      calls,
    });
    expect(d).toContain("running a step right now, for 4m");
    expect(d).toContain("steps so far: 7 (3 on its own");
    expect(d).toContain("<@U1>: use the dark theme");
    expect(d).toContain("[6m ago] opened the PR");
    const callLines = d.split("\n").filter((l) => l.includes("Bash:"));
    expect(callLines).toHaveLength(DIGEST_CALLS);
    expect(callLines[0]).toContain("part 5");
    expect(callLines.at(-1)).toContain("(failed)");
    expect(Math.max(...callLines.map((l) => l.length))).toBeLessThan(200);
  });

  test("idle and empty", () => {
    const d = buildDigest({ now, worker: { state: "idle" }, turns: 1, autoTurns: 0, steers: [], replies: [], calls: [] });
    expect(d).toContain("idle");
    expect(d).toContain("has not replied yet");
    expect(d).toContain("no worker tool calls");
  });

  test("callSummary picks the part worth a glance", () => {
    expect(callSummary('{"command":"git status"}')).toBe("git status");
    expect(callSummary('{"file_path":"/a/b.ts","limit":3}')).toBe("/a/b.ts");
    expect(callSummary("not json")).toBe("not json");
  });
});

describe("worker side", () => {
  test("the next step names who said what, with their Slack tag", () => {
    const msg = steeredMessage(
      "carry on with the next step of the task",
      [
        { by: "U1", text: "use the dark theme", at: 1 },
        { by: "U2", text: "skip the footer", at: 2 },
      ],
      (id) => (id === "U1" ? "Kai" : undefined),
    );
    expect(msg).toContain("Kai (<@U1>) said mid-task: use the dark theme");
    expect(msg).toContain("<@U2> said mid-task: skip the footer");
    expect(msg).toContain("carry on with the next step of the task");
    expect(steeredMessage("go", [], () => undefined)).toBe("go");
  });

  test("only the last few replies are kept, clipped", () => {
    let kept = keepReplies([], { text: "a", at: 1 });
    for (let i = 2; i <= 6; i++) kept = keepReplies(kept, { text: "y".repeat(5000), at: i });
    expect(kept).toHaveLength(WORKER_REPLIES_KEPT);
    expect(kept[0]?.at).toBe(4);
    expect(kept[0]!.text.length).toBeLessThan(1000);
  });

  test("the front has its own key beside the worker's", () => {
    expect(frontKeyOf("C1:100.1")).toBe("C1:100.1:front");
  });

  test("prompts: the worker keeps status short, the front knows the steer marker", () => {
    expect(workflowPrompt("Jarvis", "t")).toContain("said mid-task");
    expect(workflowPrompt("Jarvis", "t")).toContain("Keep them short");
    expect(frontPrompt("Jarvis", "rebuild the blog")).toContain("[steer]");
    expect(frontPrompt("Jarvis", "rebuild the blog")).toContain("rebuild the blog");
  });
});
