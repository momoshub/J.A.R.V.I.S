import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = join(import.meta.dir, "..", "..", "bin", "merge-when-green.sh");
const SHA = "abc123";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Check = { name: string; bucket: string };
/** One poll: the PR head GitHub shows, and what `pr checks` answers (null = none reported yet). */
type Round = { head?: string; checks: Check[] | null };

/**
 * A stand-in `gh` on PATH. `pr view` answers the current round's head, `pr
 * checks` its checks and then moves to the next round (the last one repeats),
 * and `pr merge` leaves a marker with its arguments - the gate is tested
 * without a real PR.
 */
const fakeGh = (rounds: Round[]) => {
  const dir = mkdtempSync(join(tmpdir(), "merge-green-test-"));
  dirs.push(dir);
  rounds.forEach((r, i) => {
    writeFileSync(join(dir, `head.${i}`), r.head ?? SHA);
    writeFileSync(join(dir, `checks.${i}`), r.checks === null ? "" : JSON.stringify(r.checks));
  });
  const last = rounds.length - 1;
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env bash
n=$(cat "${dir}/count" 2>/dev/null || echo 0)
[ "$n" -gt ${last} ] && n=${last}
if [ "$1 $2" = "pr view" ]; then cat "${dir}/head.$n"; exit 0; fi
if [ "$1 $2" = "pr checks" ]; then
  echo $((n + 1)) > "${dir}/count"
  if [ ! -s "${dir}/checks.$n" ]; then echo "no checks reported on the 'fix' branch" >&2; exit 1; fi
  cat "${dir}/checks.$n"; exit 0
fi
if [ "$1 $2" = "pr merge" ]; then echo "$@" > "${dir}/merged"; exit 0; fi
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
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MERGE_POLL_SECONDS: "0", MERGE_HEAD_SHA: SHA },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code, merged: existsSync(join(dir, "merged")) ? readFileSync(join(dir, "merged"), "utf8") : null };
};

const ci = (bucket: string): Check => ({ name: "checks", bucket });
const guardian: Check = { name: "GitGuardian Security Checks", bucket: "pass" };

describe("merge-when-green.sh", () => {
  test("no PR -> usage, nothing merged", async () => {
    const r = await run(fakeGh([{ checks: [ci("pass")] }]), []);
    expect(r.code).toBe(2);
    expect(r.merged).toBeNull();
  });

  test("waits for checks to appear and finish, then merges pinned to the pushed commit", async () => {
    const dir = fakeGh([{ checks: null }, { checks: [ci("pending"), guardian] }, { checks: [ci("pass"), guardian] }]);
    const r = await run(dir, ["42"]);
    expect(r.code).toBe(0);
    expect(r.merged).toContain(`pr merge 42 --merge --match-head-commit ${SHA}`);
  });

  test("a fast third-party pass alone is not CI: it waits for the CI check", async () => {
    const dir = fakeGh([{ checks: [guardian] }, { checks: [ci("pass"), guardian] }]);
    const r = await run(dir, ["42"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "count"), "utf8").trim()).toBe("2");
  });

  test("only the third-party pass, ever -> times out unmerged", async () => {
    const r = await run(fakeGh([{ checks: [guardian] }]), ["42", "0"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("'checks' has not appeared");
    expect(r.merged).toBeNull();
  });

  test("green checks on an older head are not this commit's: it waits for the push", async () => {
    const dir = fakeGh([{ head: "old999", checks: [ci("pass")] }, { checks: [ci("pass")] }]);
    // the old head never reaches pr checks, so the round only moves once the head matches
    const r = await run(dir, ["42", "0"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("waiting for abc123");
    expect(r.merged).toBeNull();
  });

  test("a failed or cancelled check is never merged", async () => {
    for (const bucket of ["fail", "cancel"]) {
      const r = await run(fakeGh([{ checks: [ci("pending")] }, { checks: [ci(bucket), guardian] }]), ["42"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("not merging");
      expect(r.merged).toBeNull();
    }
  });

  test("checks that never finish time out unmerged, and say to run it again", async () => {
    const r = await run(fakeGh([{ checks: [ci("pending")] }]), ["42", "0"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("run it again");
    expect(r.merged).toBeNull();
  });

  test("a PR whose checks never show up is not merged either", async () => {
    const r = await run(fakeGh([{ checks: null }]), ["42", "0"]);
    expect(r.code).toBe(3);
    expect(r.merged).toBeNull();
  });
});
