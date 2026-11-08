import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const run = async (orcaBin: string, args: string[]) => {
  const proc = Bun.spawn({
    cmd: [process.execPath, SCRIPT, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ORCA_BIN: orcaBin },
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
