import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = join(import.meta.dir, "..", "..", "bin", "artifact-read.sh");
const ART = "https://claude.ai/artifact/AbCdEfGhIjKlMnOpQrStUv?sk=abc";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A stand-in `claude` on PATH, so the helper's orchestration is tested without
 * opening a real session: it answers `--bg` the way the CLI does, writes the
 * content to the file named in the prompt, and records the environment it was
 * given so the scrubbing can be asserted.
 */
const fakeClaude = (content: string | null) => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-test-"));
  dirs.push(dir);
  const envDump = join(dir, "env.txt");
  writeFileSync(
    join(dir, "claude"),
    `#!/usr/bin/env bash
if [ "$1" = "--bg" ]; then
  env | grep -E '^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT)' > "${envDump}" || true
  out=$(printf '%s' "$*" | grep -oE '/[^ ]*artifact-read[A-Za-z0-9.]*' | head -1)
  ${content === null ? ":" : `[ -n "$out" ] && printf '%s' ${JSON.stringify(content)} > "$out"`}
  echo "backgrounded · abc12345"
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );
  chmodSync(join(dir, "claude"), 0o755);
  return { dir, envDump };
};

const run = async (url: string, env: Record<string, string> = {}, extraPath?: string, timeout = "4") => {
  const proc = Bun.spawn({
    cmd: ["bash", SCRIPT, url, timeout],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env, ...(extraPath ? { PATH: `${extraPath}:${process.env.PATH}` } : {}) },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
};

describe("artifact-read.sh", () => {
  test("it refuses anything that is not a claude.ai artifact url", async () => {
    const r = await run("https://example.com/thing");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not a claude.ai artifact url");
  });

  test("it prints what the session wrote", async () => {
    const { dir } = fakeClaude("the artifact body");
    const r = await run(ART, {}, dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("the artifact body");
  });

  test("it scrubs the calling session's markers, or the session it opens is a child", async () => {
    // called by hand it worked; called from inside a `read` spawn the session
    // reported "Artifact tool is not available in this session", because a
    // session that inherits these comes up nested and without the tool
    const { dir, envDump } = fakeClaude("body");
    await run(ART, { CLAUDE_CODE_CHILD_SESSION: "1", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" }, dir);

    const seen = await Bun.file(envDump).text();
    expect(seen).not.toContain("CLAUDE_CODE_CHILD_SESSION");
    expect(seen).not.toContain("CLAUDE_CODE_SESSION_ID");
    expect(seen).not.toContain("CLAUDECODE=");
  });

  test(
    "a session that writes nothing times out rather than hanging",
    async () => {
      const { dir } = fakeClaude(null);
      const r = await run(ART, {}, dir, "4");
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("timed out");
    },
    15_000,
  );
});
