import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { parseWorkerUsageLine } from "../../src/domain/workerUsage.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "bin", "orca-worker-wait.ts");

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orca-worker-wait-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake `orca` that prints this `worker-show` answer. */
const fakeOrca = (json: unknown): string => {
  const path = join(dir, "orca");
  writeFileSync(path, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(json)}\nJSON\n`);
  chmodSync(path, 0o755);
  return path;
};

const run = async (orcaBin: string, args: string[], extra: Record<string, string> = {}) => {
  const proc = Bun.spawn({
    cmd: [process.execPath, SCRIPT, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ORCA_BIN: orcaBin, ...extra },
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, code };
};

const waiting = { ok: true, result: { projection: { outcome: "in_progress", liveness: { verdict: "live" }, attention: { categories: ["approval"] } } } };

describe("bin/orca-worker-wait.ts", () => {
  test("orca missing is a broken check (127), never 'still running'", async () => {
    const r = await run(join(dir, "no-such-orca"), ["ctx_abc"]);
    expect(r.code).toBe(127);
    expect(r.stdout).toContain("could not run");
  });

  test("finished prints the line the hand-back reads", async () => {
    const r = await run(fakeOrca({ ok: true, result: { projection: { outcome: "succeeded", liveness: { verdict: "exited" } } } }), ["ctx_abc"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("orca worker ctx_abc finished: outcome succeeded");
  });

  test("a finished worker also prints what its transcript used", async () => {
    const cwd = "/work/tree";
    const projects = join(dir, "claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(projects, { recursive: true });
    writeFileSync(
      join(projects, "sess-9.jsonl"),
      `${JSON.stringify({ type: "assistant", uuid: "u-1", message: { id: "msg_1", model: "claude-haiku-4-5", usage: { input_tokens: 10, output_tokens: 20 } } })}\n`,
    );
    const show = { ok: true, result: { projection: { outcome: "succeeded" }, terminal: { worktreePath: cwd }, dispatch: { runId: "run_7" } } };
    const read = { ok: true, result: { source: "transcript", sourceExact: true, transcript: { messages: [{ id: "u-1" }] } } };
    const orca = join(dir, "orca");
    writeFileSync(
      orca,
      `#!/bin/sh\ncase "$*" in\n  *worker-read*) cat <<'JSON'\n${JSON.stringify(read)}\nJSON\n;;\n  *) cat <<'JSON'\n${JSON.stringify(show)}\nJSON\n;;\nesac\n`,
    );
    chmodSync(orca, 0o755);
    const r = await run(orca, ["ctx_abc"], { CLAUDE_CONFIG_DIR: join(dir, "claude") });
    expect(r.code).toBe(0);
    const [first, second] = r.stdout.trim().split("\n");
    expect(first).toBe("orca worker ctx_abc finished: outcome succeeded, run run_7");
    const usage = parseWorkerUsageLine(second ?? "");
    expect(usage).toMatchObject({ dispatchId: "ctx_abc", sessionId: "sess-9", runId: "run_7" });
    expect(usage?.models[0]).toMatchObject({ model: "claude-haiku-4-5", input: 10, output: 20 });
  });

  test("waiting fires, unless --past-wait", async () => {
    const orca = fakeOrca(waiting);
    const a = await run(orca, ["ctx_abc"]);
    expect(a.code).toBe(0);
    expect(a.stdout).toContain("orca worker ctx_abc waiting:");
    const b = await run(orca, ["ctx_abc", "--past-wait"]);
    expect(b.code).toBe(1);
    expect(b.stdout).toContain("still waiting for input");
  });

  test("an answer that is not a worker record keeps polling (2)", async () => {
    const r = await run(fakeOrca({ ok: false, error: { code: "runtime_unavailable" } }), ["ctx_abc"]);
    expect(r.code).toBe(2);
  });
});
