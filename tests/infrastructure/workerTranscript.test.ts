import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  measureWorker,
  resolveWorkerSession,
  runDispatches,
  transcriptMessageId,
  workerPlace,
} from "../../src/infrastructure/system/workerTranscript.ts";
import type { OrcaRun } from "../../src/infrastructure/system/orcaTerminal.ts";
import { projectSlug } from "../../src/domain/workerUsage.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "worker-transcript-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CWD = "/Users/x/Work.space";
const readOut = (id: string) =>
  JSON.stringify({ ok: true, result: { source: "transcript", sourceExact: true, transcript: { messages: [{ id, role: "assistant" }] } } });
const showOut = (cwd = CWD) =>
  JSON.stringify({ ok: true, result: { dispatch: { runId: "run_1", dispatchedAt: "2026-11-08 09:43:47" }, terminal: { worktreePath: cwd } } });

const fakeOrca = (answers: { read?: string; show?: string }): OrcaRun => async (args) => ({
  code: 0,
  stdout: args.includes("worker-read") ? (answers.read ?? "") : args.includes("worker-show") ? (answers.show ?? "") : "",
});

const assistant = (uuid: string, msgId: string, output: number) =>
  JSON.stringify({ type: "assistant", uuid, message: { id: msgId, model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: output } } });

const writeSession = (project: string, session: string, lines: string[]): string => {
  const d = join(dir, project);
  mkdirSync(d, { recursive: true });
  const f = join(d, `${session}.jsonl`);
  writeFileSync(f, `${lines.join("\n")}\n`);
  return f;
};

describe("parsing Orca's answers", () => {
  test("a message id only from an exact transcript read", () => {
    expect(transcriptMessageId(readOut("u-1"))).toBe("u-1");
    expect(transcriptMessageId(JSON.stringify({ ok: true, result: { source: "terminal", transcript: { messages: [{ id: "x" }] } } }))).toBeUndefined();
    expect(transcriptMessageId("orca: not running")).toBeUndefined();
  });

  test("place reads the worktree, Run and dispatch time (UTC)", () => {
    expect(workerPlace(showOut())).toEqual({ cwd: CWD, runId: "run_1", startedAt: Date.parse("2026-11-08T09:43:47Z") });
    expect(workerPlace("{}")).toEqual({});
  });

  test("dispatches of a Run, each once", () => {
    const out = JSON.stringify({ ok: true, result: { tasks: [{ dispatchId: "ctx_a1" }, { dispatchId: "ctx_a1" }, { dispatchId: null }, { dispatchId: "ctx_b2" }] } });
    expect(runDispatches(out)).toEqual(["ctx_a1", "ctx_b2"]);
    expect(runDispatches("nope")).toEqual([]);
  });
});

describe("resolveWorkerSession", () => {
  test("finds the session holding the worker's message in its own project folder, with subagents", async () => {
    writeSession(projectSlug(CWD), "other", [assistant("u-0", "msg_0", 1)]);
    const f = writeSession(projectSlug(CWD), "sess-1", [assistant("u-1", "msg_1", 5)]);
    const subs = join(dir, projectSlug(CWD), "sess-1", "subagents");
    mkdirSync(subs, { recursive: true });
    writeFileSync(join(subs, "agent-a.jsonl"), assistant("u-2", "msg_2", 7));
    const r = await resolveWorkerSession("ctx_1", { orca: fakeOrca({ read: readOut("u-1"), show: showOut() }), projectsDir: dir });
    expect(r).toMatchObject({ dispatchId: "ctx_1", sessionId: "sess-1", runId: "run_1", cwd: CWD });
    if ("error" in r) throw new Error(r.error);
    expect(r.files).toEqual([f, join(subs, "agent-a.jsonl")]);
  });

  test("falls back to other project folders, skipping files older than the dispatch", async () => {
    const old = writeSession("-elsewhere-old", "stale", [assistant("u-9", "msg_9", 1)]);
    const past = Date.parse("2026-11-01T00:00:00Z") / 1000;
    utimesSync(old, past, past);
    writeSession("-elsewhere", "sess-2", [assistant("u-9", "msg_9", 1)]);
    const r = await resolveWorkerSession("ctx_1", { orca: fakeOrca({ read: readOut("u-9"), show: showOut("/not/here") }), projectsDir: dir });
    expect(r).toMatchObject({ sessionId: "sess-2" });
  });

  test("no transcript, or no file holding it, is an error, never a throw", async () => {
    expect(await resolveWorkerSession("ctx_1", { orca: fakeOrca({}), projectsDir: dir })).toHaveProperty("error");
    expect(
      await resolveWorkerSession("ctx_1", { orca: fakeOrca({ read: readOut("u-404"), show: showOut() }), projectsDir: dir }),
    ).toHaveProperty("error");
  });

  test("measureWorker sums the session and its subagents", async () => {
    writeSession(projectSlug(CWD), "sess-1", [assistant("u-1", "msg_1", 5), assistant("u-1b", "msg_1", 5)]);
    const subs = join(dir, projectSlug(CWD), "sess-1", "subagents");
    mkdirSync(subs, { recursive: true });
    writeFileSync(join(subs, "agent-a.jsonl"), assistant("u-2", "msg_2", 7));
    const r = await measureWorker("ctx_1", { orca: fakeOrca({ read: readOut("u-1"), show: showOut() }), projectsDir: dir });
    if ("error" in r) throw new Error(r.error);
    expect(r.models[0]).toMatchObject({ messages: 2, output: 12, input: 2 });
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.runId).toBe("run_1");
  });
});
