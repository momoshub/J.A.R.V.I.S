import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolTraceLog, TRACE_FIELD_CHARS, traceFileFor } from "../../src/infrastructure/llm/toolTraceLog.ts";

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
