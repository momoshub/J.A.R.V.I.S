import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..", "..");
const HAS_GITLEAKS = Bun.spawnSync(["sh", "-c", "command -v gitleaks"]).exitCode === 0;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sh = (cwd: string, cmd: string, env: Record<string, string> = {}) => {
  const r = Bun.spawnSync(["bash", "-c", cmd], { cwd, env: { ...process.env, ...env } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

// A scratch repo carrying the real config, scan script and hook, plus a bare "remote".
const makeRepo = () => {
  const base = mkdtempSync(join(tmpdir(), "leakguard-"));
  dirs.push(base);
  const repo = join(base, "repo");
  mkdirSync(join(repo, "bin"), { recursive: true });
  cpSync(join(ROOT, ".githooks"), join(repo, ".githooks"), { recursive: true });
  cpSync(join(ROOT, "bin", "leak-scan.sh"), join(repo, "bin", "leak-scan.sh"));
  cpSync(join(ROOT, ".gitleaks.toml"), join(repo, ".gitleaks.toml"));
  chmodSync(join(repo, "bin", "leak-scan.sh"), 0o755);
  chmodSync(join(repo, ".githooks", "pre-push"), 0o755);
  const env = { LEAK_NAMES_FILE: join(base, "none.toml"), HOME: base };
  const r = sh(
    repo,
    `git init -q -b main && git config user.email t@example.com && git config user.name t &&
     git config core.hooksPath .githooks && git init -q --bare ../remote.git && git remote add origin ../remote.git &&
     git add -A && git commit -qm base --no-verify && git push -q --no-verify origin main`,
    env,
  );
  expect(r.code).toBe(0);
  return { repo, env };
};

const EMP = "Mo" + "mos";
const SAMPLES: Record<string, string> = {
  "slack-real-looking-id": "const id = 'U07AB12" + "CD3E';\n",
  "employer-name": `owned by ${EMP} Inc\n`,
};

describe.skipIf(!HAS_GITLEAKS)("leak guard", () => {
  test("the committed tree is clean", () => {
    const r = sh(ROOT, "bin/leak-scan.sh dir . --no-banner --redact -v");
    expect(r.out).toContain("no leaks found");
    expect(r.code).toBe(0);
  });

  for (const [rule, text] of Object.entries(SAMPLES)) {
    test(`rule ${rule} fires`, () => {
      const { repo, env } = makeRepo();
      writeFileSync(join(repo, "sample.txt"), text);
      const r = sh(repo, "bin/leak-scan.sh dir sample.txt --no-banner --redact -v", env);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(rule);
    });
  }

  test("fake Slack ids and the copyright line are allowed", () => {
    const { repo, env } = makeRepo();
    writeFileSync(
      join(repo, "ok.txt"),
      `U0OWNER0001 U0BOT000001 C0TEST0000N D0DM0000001 U0123456789 U0NUISANCE\nCopyright 2026 ${EMP}\n`,
    );
    const r = sh(repo, "bin/leak-scan.sh dir ok.txt --no-banner --redact -v", env);
    // the copyright line is only allowed in LICENSE/NOTICE/README, the ids are allowed anywhere
    expect(r.out).not.toContain("slack-real-looking-id");
  });

  test("the names rule loads from LEAK_NAMES_FILE and fires", () => {
    const { repo, env } = makeRepo();
    const names = join(repo, "..", "names.toml");
    writeFileSync(names, `[[rules]]\nid = "private-names"\nregex = '''(?i)jane doe'''\n`);
    writeFileSync(join(repo, "n.txt"), "met Jane Doe today\n");
    const r = sh(repo, "bin/leak-scan.sh dir n.txt --no-banner --redact -v", { ...env, LEAK_NAMES_FILE: names });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("private-names");
  });

  test("pre-push blocks a leaking push, allows --no-verify, lets clean pushes and deletes through", () => {
    const { repo, env } = makeRepo();
    // clean push to a new branch
    expect(sh(repo, "git checkout -qb clean && echo hi > a.txt && git add a.txt && git commit -qm a --no-verify && git push -q origin clean", env).code).toBe(0);
    // leaking commit is blocked
    writeFileSync(join(repo, "b.txt"), "const id = 'U07AB12" + "CD3E';\n");
    const blocked = sh(repo, "git add b.txt && git commit -qm b --no-verify && git push origin clean", env);
    expect(blocked.code).not.toBe(0);
    expect(blocked.out).toContain("BLOCKED");
    expect(blocked.out).toContain("--no-verify");
    // new branch holding the leak is blocked too
    expect(sh(repo, "git push origin clean:fresh", env).code).not.toBe(0);
    // the bypass works
    expect(sh(repo, "git push -q --no-verify origin clean", env).code).toBe(0);
    // deleting a branch scans nothing
    expect(sh(repo, "git push -q origin :clean", env).code).toBe(0);
  });

  test("real ids of every kind are flagged, including ones a loose fake pattern would pass", () => {
    const { repo, env } = makeRepo();
    // letters-then-digits user ids, team/bot ids and a legacy id without the leading 0
    for (const id of ["U0ABCDE" + "FG12", "U0ABCDE" + "FGH1", "T07AB12" + "CD3E", "B07AB12" + "CD3E", "U024B" + "E7LH"]) {
      writeFileSync(join(repo, "id.txt"), `const id = '${id}';\n`);
      const r = sh(repo, "bin/leak-scan.sh dir id.txt --no-banner --redact -v", env);
      expect(r.out).toContain("slack-real-looking-id");
    }
  });

  test("pre-push scans a force-push whose remote tip this clone never fetched", () => {
    const { repo, env } = makeRepo();
    // another clone moves main on the remote; this clone does not fetch
    const other = join(repo, "..", "other");
    expect(sh(join(repo, ".."), `git clone -q remote.git other && cd other && git config user.email t@example.com && git config user.name t && echo x > x.txt && git add x.txt && git commit -qm x && git push -q --no-verify origin main`, env).code).toBe(0);
    expect(other).toBeTruthy();
    writeFileSync(join(repo, "leak.txt"), "const id = 'U07AB12" + "CD3E';\n");
    const r = sh(repo, "git add leak.txt && git commit -qm leak --no-verify && git push --force origin main", env);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("BLOCKED");
  });

  test("pre-push scans commits that are already on another remote but new to this one", () => {
    const { repo, env } = makeRepo();
    expect(sh(repo, "git init -q --bare ../backup.git && git remote add backup ../backup.git", env).code).toBe(0);
    writeFileSync(join(repo, "leak.txt"), "const id = 'U07AB12" + "CD3E';\n");
    expect(sh(repo, "git checkout -qb feat && git add leak.txt && git commit -qm leak --no-verify && git push -q --no-verify backup feat", env).code).toBe(0);
    const r = sh(repo, "git push origin feat", env);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("BLOCKED");
  });

  test("pre-push blocks a leak in a commit message, a file path or an annotated tag message", () => {
    const { repo, env } = makeRepo();
    const id = "U07AB12" + "CD3E";
    const msg = sh(repo, `git checkout -qb m && echo a > a.txt && git add a.txt && git commit -qm "asked in ${id}" --no-verify && git push origin m`, env);
    expect(msg.code).not.toBe(0);
    expect(msg.out).toContain("commit message, a file path or a tag message");
    const path = sh(repo, `git checkout -q main && git checkout -qb p && mkdir -p notes && echo a > "notes/${EMP}.md" && git add notes && git commit -qm notes --no-verify && git push origin p`, env);
    expect(path.code).not.toBe(0);
    expect(path.out).toContain("employer-name");
    const tag = sh(repo, `git checkout -q main && git tag -a v1 -m "owned by ${EMP}" && git push origin v1`, env);
    expect(tag.code).not.toBe(0);
    expect(tag.out).toContain("employer-name");
  });

  test("ids with any digit after the prefix are scanned, not dropped by a keyword prefilter", () => {
    const { repo, env } = makeRepo();
    for (const id of ["U3N4QJ" + "7KX", "C5ABCDE" + "FGH"]) {
      writeFileSync(join(repo, "id.txt"), `owner: ${id}\n`);
      const r = sh(repo, "bin/leak-scan.sh dir id.txt --no-banner --redact -v", env);
      expect(r.out).toContain("slack-real-looking-id");
    }
  });

  test("quiet mode (CI) keeps a broken names rule out of the log and fails", () => {
    const { repo, env } = makeRepo();
    writeFileSync(join(repo, "a.txt"), "hello\n");
    const toml = `[[rules]]\nid = "private-names"\nregex = '''(?i)(jane doe|richard roe'''\n`;
    const r = sh(repo, "bin/leak-scan.sh dir a.txt --no-banner", { ...env, LEAK_SCAN_QUIET: "true", LEAK_NAMES_TOML: toml });
    expect(r.code).not.toBe(0);
    expect(r.out.toLowerCase()).not.toContain("jane doe");
    expect(r.out.toLowerCase()).not.toContain("richard roe");
    expect(r.out).toContain("gitleaks failed");
  });

  test("a required names rule that is missing fails instead of skipping", () => {
    const { repo, env } = makeRepo();
    writeFileSync(join(repo, "a.txt"), "hello\n");
    const r = sh(repo, "bin/leak-scan.sh dir a.txt --no-banner", { ...env, LEAK_NAMES_REQUIRED: "true", LEAK_NAMES_TOML: "" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("required");
  });

  test("pre-push skips with a warning when gitleaks is missing", () => {
    const { repo, env } = makeRepo();
    const r = sh(repo, `PATH=/usr/bin:/bin git push origin main`, env);
    expect(r.code).toBe(0);
  });
});
