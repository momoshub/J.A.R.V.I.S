import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = join(import.meta.dir, "..", "..", "bin", "merge-when-green.sh");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A stand-in `gh` on PATH: `pr checks` answers each call with the next
 * (exit code, output) pair, and `pr merge` leaves a marker, so the gate is
 * tested without a real PR.
 */
const fakeGh = (answers: Array<[number, string]>) => {
  const dir = mkdtempSync(join(tmpdir(), "merge-green-test-"));
  dirs.push(dir);
  answers.forEach(([code, out], i) => {
    writeFileSync(join(dir, `answer-${i}`), `${code}\n${out}`);
  });
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env bash
if [ "$1 $2" = "pr checks" ]; then
  n=$(cat "${dir}/count" 2>/dev/null || echo 0)
  echo $((n + 1)) > "${dir}/count"
  f="${dir}/answer-$n"
  [ -f "$f" ] || f=$(ls "${dir}"/answer-* | sort -t- -k2 -n | tail -1)
  tail -n +2 "$f"
  exit "$(head -1 "$f")"
fi
if [ "$1 $2" = "pr merge" ]; then
  echo "$@" > "${dir}/merged"
  exit 0
fi
exit 1
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  return dir;
};

const run = async (dir: string, args: string[]) => {
  const proc = Bun.spawn({
    cmd: ["bash", SCRIPT, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MERGE_POLL_SECONDS: "0" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code, merged: existsSync(join(dir, "merged")) ? readFileSync(join(dir, "merged"), "utf8") : null };
};

describe("merge-when-green.sh", () => {
  test("no PR -> usage, nothing merged", async () => {
    const dir = fakeGh([[0, "checks pass"]]);
    const r = await run(dir, []);
    expect(r.code).toBe(2);
    expect(r.merged).toBeNull();
  });

  test("waits for checks to appear and finish, then merges with a merge commit", async () => {
    const dir = fakeGh([
      [1, "no checks reported on the 'fix' branch"],
      [8, "checks pending"],
      [0, "checks pass"],
    ]);
    const r = await run(dir, ["42"]);
    expect(r.code).toBe(0);
    expect(r.merged).toContain("pr merge 42 --merge");
  });

  test("a failed check is never merged", async () => {
    const dir = fakeGh([[8, "pending"], [1, "checks fail"]]);
    const r = await run(dir, ["42"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not merging");
    expect(r.merged).toBeNull();
  });

  test("checks that never finish time out unmerged", async () => {
    const dir = fakeGh([[8, "pending"]]);
    const r = await run(dir, ["42", "0"]);
    expect(r.code).toBe(3);
    expect(r.merged).toBeNull();
  });

  test("a PR whose checks never show up is not merged either", async () => {
    const dir = fakeGh([[1, "no checks reported on the 'fix' branch"]]);
    const r = await run(dir, ["42", "0"]);
    expect(r.code).toBe(3);
    expect(r.merged).toBeNull();
  });
});
