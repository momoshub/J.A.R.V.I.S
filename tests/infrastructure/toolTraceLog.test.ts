import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createToolTraceLog,
  readTraceCalls,
  TRACE_FIELD_CHARS,
  traceFileFor,
} from "../../src/infrastructure/llm/toolTraceLog.ts";

const NOW = new Date("2026-11-05T10:00:00.000Z");
const bill = { actor: "U1", kind: "chat", channel: "C1", threadTs: "111.1" };

describe("per-thread tool trace log", () => {
  test("one file per thread, one line per call or result, in order", () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-"));
    const log = createToolTraceLog(dir, () => NOW);
    log({ kind: "call", id: "t1", name: "Bash", input: '{"command":"ls"}' }, bill);
    log({ kind: "result", id: "t1", isError: false, output: "a\nb" }, bill);
    log({ kind: "call", id: "t9", name: "Bash", input: "{}" }, { ...bill, threadTs: "222.2" });

    const lines = readFileSync(join(dir, "C1", "111.1.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { at: NOW.toISOString(), actor: "U1", run: "chat", kind: "call", id: "t1", name: "Bash", input: '{"command":"ls"}' },
      { at: NOW.toISOString(), actor: "U1", run: "chat", kind: "result", id: "t1", isError: false, output: "a\nb" },
    ]);
    expect(readFileSync(join(dir, "C1", "222.2.jsonl"), "utf8")).toContain('"t9"');
  });

  test("reports where each line landed: a path relative to the root, and its line number", () => {
    const root = mkdtempSync(join(tmpdir(), "root-"));
    const dir = join(root, "logs", "threads");
    const log = createToolTraceLog(dir, () => NOW, root);
    expect(log({ kind: "call", id: "t1", name: "Bash", input: "{}" }, bill)).toEqual({ file: "logs/threads/C1/111.1.jsonl", line: 1 });
    expect(log({ kind: "result", id: "t1", isError: false, output: "x" }, bill)).toEqual({ file: "logs/threads/C1/111.1.jsonl", line: 2 });
    expect(log({ kind: "call", id: "t2", name: "Bash", input: "{}" }, { ...bill, threadTs: "222.2" })).toMatchObject({ line: 1 });
    // a restarted process carries on from what is already in the file
    const again = createToolTraceLog(dir, () => NOW, root);
    expect(again({ kind: "call", id: "t3", name: "Bash", input: "{}" }, bill)).toMatchObject({ line: 3 });
  });

  test("a log outside the root reports no spot, so no host path reaches a card", () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "root-"));
    const log = createToolTraceLog(dir, () => NOW, elsewhere);
    expect(log({ kind: "call", id: "t1", name: "Bash", input: "{}" }, bill)).toBeUndefined();
    expect(readFileSync(join(dir, "C1", "111.1.jsonl"), "utf8")).toContain('"t1"');
  });

  test("redacts secrets and clips a huge output", () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-"));
    const log = createToolTraceLog(dir, () => NOW);
    log({ kind: "result", id: "t1", isError: false, output: `token xoxb-1234567890-abcdefghijkl ${"z".repeat(TRACE_FIELD_CHARS + 50)}` }, bill);
    const line = JSON.parse(readFileSync(join(dir, "C1", "111.1.jsonl"), "utf8"));
    expect(line.output).not.toContain("xoxb-1234567890");
    expect(line.output).toContain("[clipped");
    expect(line.output.length).toBeLessThan(TRACE_FIELD_CHARS + 100);
  });

  test("a run with no thread, or a hostile id, cannot escape the directory", () => {
    expect(traceFileFor("/d", undefined, NOW)).toBe("/d/_none/2026-11-05.jsonl");
    expect(traceFileFor("/d", { actor: "U1", kind: "x", channel: "../../etc", threadTs: "../p" }, NOW)).toBe(
      "/d/__.._etc/__p.jsonl",
    );
    expect(traceFileFor("/d", { actor: "U1", kind: "x", channel: "..", threadTs: "." }, NOW)).toBe("/d/_/_.jsonl");
  });
});

describe("reading a thread's trace back for the workflow digest", () => {
  test("the newest calls of one run kind, oldest first, failures marked", () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-"));
    const log = createToolTraceLog(dir, () => NOW);
    const worker = { ...bill, kind: "workflow" };
    const front = { ...bill, kind: "workflow-front" };
    for (let i = 0; i < 20; i++) log({ kind: "call", id: `w${i}`, name: "Bash", input: `{"command":"step ${i}"}` }, worker);
    log({ kind: "result", id: "w19", isError: true, output: "boom" }, worker);
    log({ kind: "call", id: "f1", name: "Read", input: '{"file_path":"/x"}' }, front);

    const calls = readTraceCalls(dir, "C1", "111.1", "workflow", 15);
    expect(calls).toHaveLength(15);
    expect(calls[0]?.input).toContain("step 5");
    expect(calls.at(-1)).toEqual({ at: NOW.toISOString(), name: "Bash", input: '{"command":"step 19"}', isError: true });
    expect(calls.some((c) => c.name === "Read")).toBe(false);
  });

  test("a missing file is no calls, and a cut-off first line is skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-"));
    expect(readTraceCalls(dir, "C1", "nope", "workflow", 15)).toEqual([]);
    const log = createToolTraceLog(dir, () => NOW);
    const worker = { ...bill, kind: "workflow" };
    log({ kind: "call", id: "a", name: "Bash", input: `{"command":"${"x".repeat(500)}"}` }, worker);
    log({ kind: "call", id: "b", name: "Grep", input: '{"pattern":"todo"}' }, worker);
    const calls = readTraceCalls(dir, "C1", "111.1", "workflow", 15, 200);
    expect(calls.map((c) => c.name)).toEqual(["Grep"]);
  });
});
