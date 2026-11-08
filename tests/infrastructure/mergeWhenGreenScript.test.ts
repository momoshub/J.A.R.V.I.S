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
/**
 * One poll: the PR head GitHub shows, its "<mergeable> <mergeStateStatus>"
 * (default "MERGEABLE CLEAN"), and what `pr checks` answers (null = none reported yet).
 */
type Round = { head?: string; mergeable?: string; checks: Check[] | null };

type Review = { author: { login: string }; state: string; commit: { oid: string } };
/** Who runs the merge, who opened the PR, the reviews already on it, and whether `pr review` fails. */
type Accounts = { me?: string; author?: string; reviews?: Review[]; reviewFails?: boolean };

/**
 * A stand-in `gh` on PATH. `pr view` answers the current round's head (or its
 * mergeability, or the PR author / reviews when asked for them), `pr checks` its checks and then
 * moves to the next round (the last one repeats), `api user` the merging
 * login, and `pr review` / `pr merge` leave a marker with their arguments -
 * the gate is tested without a real PR. By default a second account merges, so
 * every merge is approved first.
 */
const fakeGh = (rounds: Round[], accounts: Accounts = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "merge-green-test-"));
  dirs.push(dir);
  rounds.forEach((r, i) => {
    writeFileSync(join(dir, `head.${i}`), r.head ?? SHA);
    writeFileSync(join(dir, `mergeable.${i}`), r.mergeable ?? "MERGEABLE CLEAN");
    writeFileSync(join(dir, `checks.${i}`), r.checks === null ? "" : JSON.stringify(r.checks));
  });
  writeFileSync(join(dir, "me"), accounts.me ?? "checker");
  writeFileSync(join(dir, "author"), accounts.author ?? "writer");
  writeFileSync(join(dir, "reviews"), JSON.stringify({ reviews: accounts.reviews ?? [] }));
  const last = rounds.length - 1;
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env bash
n=$(cat "${dir}/count" 2>/dev/null || echo 0)
[ "$n" -gt ${last} ] && n=${last}
if [ "$1 $2" = "api user" ]; then cat "${dir}/me"; exit 0; fi
if [ "$1 $2 $4 $5" = "pr view --json author" ]; then cat "${dir}/author"; exit 0; fi
if [ "$1 $2 $4 $5" = "pr view --json reviews" ]; then cat "${dir}/reviews"; exit 0; fi
if [ "$1 $2 $4 $5" = "pr view --json mergeable,mergeStateStatus" ]; then cat "${dir}/mergeable.$n"; exit 0; fi
if [ "$1 $2" = "pr view" ]; then cat "${dir}/head.$n"; exit 0; fi
if [ "$1 $2" = "pr review" ]; then echo "$@" > "${dir}/approved"; exit ${accounts.reviewFails ? 1 : 0}; fi
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
  const marker = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null);
  return { stdout, stderr, code, merged: marker("merged"), approved: marker("approved") };
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
    expect(r.approved).toContain("pr review 42 --approve --body Approved: standalone review clean, CI green (abc123)");
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

  test("nothing is approved before CI is green", async () => {
    const r = await run(fakeGh([{ checks: [ci("pending")] }]), ["42", "0"]);
    expect(r.code).toBe(3);
    expect(r.approved).toBeNull();
    const red = await run(fakeGh([{ checks: [ci("fail")] }]), ["42"]);
    expect(red.code).toBe(1);
    expect(red.approved).toBeNull();
  });

  test("the merging account opened the PR -> no approval (GitHub forbids it), still merges", async () => {
    const r = await run(fakeGh([{ checks: [ci("pass")] }], { me: "Writer", author: "writer" }), ["42"]);
    expect(r.code).toBe(0);
    expect(r.approved).toBeNull();
    expect(r.stdout).toContain("approval skipped");
    expect(r.merged).toContain("pr merge 42");
  });

  test("already approved by the merging account on this head -> no second approval", async () => {
    const reviews = [{ author: { login: "checker" }, state: "APPROVED", commit: { oid: SHA } }];
    const r = await run(fakeGh([{ checks: [ci("pass")] }], { reviews }), ["42"]);
    expect(r.code).toBe(0);
    expect(r.approved).toBeNull();
    expect(r.merged).toContain("pr merge 42");
  });

  test("an approval on an older head, or by someone else, does not count", async () => {
    const reviews = [
      { author: { login: "checker" }, state: "APPROVED", commit: { oid: "old999" } },
      { author: { login: "someone" }, state: "APPROVED", commit: { oid: SHA } },
      { author: { login: "checker" }, state: "COMMENTED", commit: { oid: SHA } },
    ];
    const r = await run(fakeGh([{ checks: [ci("pass")] }], { reviews }), ["42"]);
    expect(r.code).toBe(0);
    expect(r.approved).toContain("--approve");
  });

  test("a failed approval stops the merge", async () => {
    const r = await run(fakeGh([{ checks: [ci("pass")] }], { reviewFails: true }), ["42"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not merging");
    expect(r.merged).toBeNull();
  });

  test("cannot tell who merges -> no merge", async () => {
    const r = await run(fakeGh([{ checks: [ci("pass")] }], { me: "" }), ["42"]);
    expect(r.code).toBe(1);
    expect(r.approved).toBeNull();
    expect(r.merged).toBeNull();
  });

  test("a PR that conflicts with its base is refused at once with exit 4, not polled until the timeout", async () => {
    for (const mergeable of ["CONFLICTING DIRTY", "CONFLICTING UNKNOWN", "UNKNOWN DIRTY"]) {
      const dir = fakeGh([{ mergeable, checks: null }]);
      const r = await run(dir, ["42", "540"]);
      expect(r.code).toBe(4);
      expect(r.stderr).toContain("PR 42 conflicts with its base, merge the base in and resolve first - not merging");
      expect(r.merged).toBeNull();
      expect(r.approved).toBeNull();
      // it never waited for checks GitHub will not run
      expect(existsSync(join(dir, "count"))).toBe(false);
    }
  });

  test("mergeability still being computed (UNKNOWN) -> keeps polling, merges once it is known", async () => {
    const dir = fakeGh([
      { mergeable: "UNKNOWN UNKNOWN", checks: [ci("pass")] },
      { mergeable: "MERGEABLE CLEAN", checks: [ci("pass")] },
    ]);
    const r = await run(dir, ["42"]);
    expect(r.code).toBe(0);
    expect(r.merged).toContain(`pr merge 42 --merge --match-head-commit ${SHA}`);
    expect(readFileSync(join(dir, "count"), "utf8").trim()).toBe("2");
  });

  test("mergeability that never resolves -> times out unmerged with exit 3", async () => {
    const r = await run(fakeGh([{ mergeable: "UNKNOWN UNKNOWN", checks: [ci("pass")] }]), ["42", "0"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("merges cleanly");
    expect(r.approved).toBeNull();
    expect(r.merged).toBeNull();
  });
});
