import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..", "..");
// each case runs gitleaks twice per scan in scratch repos, slow on a CI runner
setDefaultTimeout(60_000);
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
  cpSync(join(ROOT, "bin", "leak-utf16.py"), join(repo, "bin", "leak-utf16.py"));
  cpSync(join(ROOT, ".gitleaks.toml"), join(repo, ".gitleaks.toml"));
  chmodSync(join(repo, "bin", "leak-scan.sh"), 0o755);
  chmodSync(join(repo, ".githooks", "pre-push"), 0o755);
  const env = { LEAK_NAMES_FILE: join(base, "none.toml"), HOME: base };
  const r = sh(
    repo,
    `git init -q -b main && git config user.email t@example.com && git config user.name t &&
     git config core.hooksPath .githooks && git init -q --bare -b main ../remote.git && git remote add origin ../remote.git &&
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

// skipped only off CI: under CI a missing gitleaks fails the suite instead of hiding it
describe.skipIf(!HAS_GITLEAKS && !process.env.CI)("leak guard", () => {
  test("the committed tree is clean", () => {
    // the files HEAD holds, not the checkout: node_modules and .git are not the repo
    const tree = mkdtempSync(join(tmpdir(), "leakguard-tree-"));
    dirs.push(tree);
    expect(sh(ROOT, `git archive HEAD | tar -x -C '${tree}'`).code).toBe(0);
    const r = sh(tree, `'${join(ROOT, "bin", "leak-scan.sh")}' dir . --no-banner --redact -v`);
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
    for (const id of ["U0ABCDE" + "FG12", "U0ABCDE" + "FGH1", "T07AB12" + "CD3E", "B07AB12" + "CD3E", "U025C" + "F8MJ"]) {
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
    expect(msg.out).toContain("a commit message, a file path, a branch or tag name");
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

  test("the commit-message allowlists cover whole lines only, in messages and files", () => {
    const { repo, env } = makeRepo();
    const org = EMP.toLowerCase() + "hub";
    for (const line of [`Merge pull request #1 from ${org}/x : our ${EMP} customer list`, `${EMP} plan, copyright holder is ${EMP}`]) {
      writeFileSync(join(repo, "f.txt"), `${line}\n`);
      expect(sh(repo, "bin/leak-scan.sh dir f.txt --no-banner --redact -v", env).out).toContain("employer-name");
      const r = sh(repo, `git checkout -q main && git checkout -qB x && git commit -q --allow-empty -m "${line}" --no-verify && LEAK_SCAN_RANGE=main..x bin/leak-scan.sh meta --no-banner --redact -v`, env);
      expect(r.out).toContain("employer-name");
    }
    const exact = sh(repo, `git checkout -q main && git checkout -qB y && git commit -q --allow-empty -m "Merge pull request #2 from ${org}/feat/x" --no-verify && LEAK_SCAN_RANGE=main..y bin/leak-scan.sh meta --no-banner --redact -v`, env);
    expect(exact.out).toContain("no leaks found");
  });

  test("no file is exempt by path: example names file, config comments, svg and lockfiles are scanned", () => {
    const { repo, env } = makeRepo();
    mkdirSync(join(repo, "docs"), { recursive: true });
    cpSync(join(ROOT, "docs", "leak-names.example.toml"), join(repo, "docs", "leak-names.example.toml"));
    const line = `# owner U07AB12${"CD3E"} at ${EMP}\n`;
    // gitleaks' defaults skip svg, lockfiles and .gitleaks.toml, so the no-defaults pass has to catch these
    for (const f of ["docs/leak-names.example.toml", ".gitleaks.toml", "docs/arch.svg", "yarn.lock", "package-lock.json", "go.sum"]) {
      writeFileSync(join(repo, f), line, { flag: "a" });
      const r = sh(repo, `bin/leak-scan.sh dir ${f} --no-banner --redact -v`, env);
      expect(r.out).toContain("slack-real-looking-id");
      expect(r.out).toContain("employer-name");
    }
    // a trailing comment after a pattern line is scanned, the bare pattern line is not
    const cfg = join(repo, ".gitleaks.toml");
    cpSync(join(ROOT, ".gitleaks.toml"), cfg);
    writeFileSync(cfg, `\n[[rules]]\nid = "extra"\nregex = '''(?i)${EMP} extra'''\nkeywords = ["${EMP.toLowerCase()}"]\n`, { flag: "a" });
    expect(sh(repo, "bin/leak-scan.sh dir .gitleaks.toml --no-banner --redact -v", env).out).toContain("no leaks found");
    writeFileSync(cfg, `regex2 = '''x''' # asked in U07AB12${"CD3E"}\n`, { flag: "a" });
    expect(sh(repo, "bin/leak-scan.sh dir .gitleaks.toml --no-banner --redact -v", env).out).toContain("slack-real-looking-id");
  });

  test("pre-push blocks an id or the employer word in a branch or tag name", () => {
    const { repo, env } = makeRepo();
    const bad = `x-U07AB12${"CD3E"}`;
    const branch = sh(repo, `git push origin main:${bad}`, env);
    expect(branch.code).not.toBe(0);
    expect(branch.out).toContain("slack-real-looking-id");
    const tag = sh(repo, `git tag ${EMP.toLowerCase()}-v1 && git push origin ${EMP.toLowerCase()}-v1`, env);
    expect(tag.code).not.toBe(0);
    expect(tag.out).toContain("employer-name");
  });

  test("a non-ASCII file path is scanned as written, not octal-quoted", () => {
    const { repo, env } = makeRepo();
    const names = join(repo, "..", "names.toml");
    writeFileSync(names, `[[rules]]\nid = "private-names"\nregex = '''(?i)renée roe'''\n`);
    const r = sh(repo, `git checkout -qb u && mkdir -p notes && echo a > "notes/renée roe.md" && git add notes && git commit -qm notes --no-verify && LEAK_SCAN_RANGE=main..u bin/leak-scan.sh meta --no-banner --redact -v`, { ...env, LEAK_NAMES_FILE: names });
    expect(r.out).toContain("private-names");
  });

  test("a required names source with no [[rules]] regex fails", () => {
    const { repo, env } = makeRepo();
    writeFileSync(join(repo, "a.txt"), "hello\n");
    for (const toml of [" ", "\n\n", "regex = '''(?i)jane doe'''\n"]) {
      const r = sh(repo, "bin/leak-scan.sh dir a.txt --no-banner", { ...env, LEAK_NAMES_REQUIRED: "true", LEAK_NAMES_TOML: toml });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("no [[rules]] with a regex");
    }
  });

  test("pre-push scans what a merge commit adds and a file .gitattributes marks binary", () => {
    const { repo, env } = makeRepo();
    const id = "U07AB12" + "CD3E";
    expect(sh(repo, "git checkout -qb side && echo s > s.txt && git add s.txt && git commit -qm s --no-verify && git checkout -q main && echo m > m.txt && git add m.txt && git commit -qm m --no-verify", env).code).toBe(0);
    expect(sh(repo, "git merge -q --no-commit side", env).code).toBe(0);
    writeFileSync(join(repo, "evil.txt"), `owner ${id}\n`);
    const merge = sh(repo, "git add evil.txt && git commit -qm merge --no-verify && git push origin main", env);
    expect(merge.code).not.toBe(0);
    expect(merge.out).toContain("slack-real-looking-id");
    expect(sh(repo, "git reset -q --hard origin/main && git checkout -qb bin", env).code).toBe(0);
    writeFileSync(join(repo, ".gitattributes"), "notes.txt -diff\n");
    writeFileSync(join(repo, "notes.txt"), `owner ${id} at ${EMP}\n`);
    const binary = sh(repo, "git add -A && git commit -qm notes --no-verify && git push origin bin", env);
    expect(binary.code).not.toBe(0);
    expect(binary.out).toContain("slack-real-looking-id");
  });

  test("an id next to an underscore or inside a key is flagged, fakes stay allowed", () => {
    const { repo, env } = makeRepo();
    for (const text of [`owner_U07AB12${"CD3E"}`, `C07AB12${"CD3E"}_history`, `SLACK_CHANNEL_C07AB12${"CD3E"}=1`]) {
      writeFileSync(join(repo, "k.txt"), `${text}\n`);
      expect(sh(repo, "bin/leak-scan.sh dir k.txt --no-banner --redact -v", env).out).toContain("slack-real-looking-id");
    }
    writeFileSync(join(repo, "k.txt"), "OWNER_U0OWNER0001 U0123456789_x\n");
    expect(sh(repo, "bin/leak-scan.sh dir k.txt --no-banner --redact -v", env).out).not.toContain("slack-real-looking-id");
  });

  test("pre-push blocks a tag that points at a blob or a tree", () => {
    const { repo, env } = makeRepo();
    const blob = sh(repo, `printf 'owner U07AB12${"CD3E"}\\n' | git hash-object -w --stdin`, env).out.trim();
    const r = sh(repo, `git update-ref refs/tags/t ${blob} && git push origin t`, env);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("not a commit");
    const tree = sh(repo, "git rev-parse HEAD^{tree}", env).out.trim();
    expect(sh(repo, `git update-ref refs/tags/tr ${tree} && git push origin tr`, env).code).not.toBe(0);
  });

  test("an id right after a string escape is flagged", () => {
    const { repo, env } = makeRepo();
    for (const text of [`"hey\\nU07AB12${"CD3E"}"`, `x\\tC07AB12${"CD3E"}`, `\\u00a0U07AB12${"CD3E"}`]) {
      writeFileSync(join(repo, "j.txt"), `${text}\n`);
      expect(sh(repo, "bin/leak-scan.sh dir j.txt --no-banner --redact -v", env).out).toContain("slack-real-looking-id");
    }
  });

  test("a default git pull merge line passes, extra text on it does not", () => {
    const { repo, env } = makeRepo();
    const org = EMP.toLowerCase() + "hub";
    const ok = `Merge branch 'main' of github.com:${org}/J.A.R.V.I.S`;
    const okInto = `Merge branch 'main' of https://github.com/${org}/J.A.R.V.I.S into feat/x`;
    for (const [line, clean] of [[ok, true], [okInto, true], [`${ok} ${EMP} notes`, false]] as const) {
      const r = sh(repo, `git checkout -q main && git checkout -qB pl && git commit -q --allow-empty -m "${line}" --no-verify && LEAK_SCAN_RANGE=main..pl bin/leak-scan.sh meta --no-banner --redact -v`, env);
      if (clean) expect(r.out).not.toContain("employer-name");
      else expect(r.out).toContain("employer-name");
    }
  });

  test("pre-push reads every tag a tag points through", () => {
    const { repo, env } = makeRepo();
    const r = sh(repo, `git tag -a inner -m "see U07AB12${"CD3E"}" HEAD && git tag -a outer -m clean inner && git tag -d inner >/dev/null && git push origin outer`, env);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("slack-real-looking-id");
  });

  test("a revert of a merged PR passes, extra text on that line does not", () => {
    const { repo, env } = makeRepo();
    const org = EMP.toLowerCase() + "hub";
    const merge = `Merge pull request #2 from ${org}/feat/x`;
    for (const [line, clean] of [[`Revert \\"${merge}\\"`, true], [`Revert \\"Revert \\"${merge}\\"\\"`, true], [`Revert \\"${merge}\\" for ${EMP}`, false]] as const) {
      const r = sh(repo, `git checkout -q main && git checkout -qB rv && git commit -q --allow-empty -m "${line}" --no-verify && LEAK_SCAN_RANGE=main..rv bin/leak-scan.sh meta --no-banner --redact -v`, env);
      if (clean) expect(r.out).not.toContain("employer-name");
      else expect(r.out).toContain("employer-name");
    }
  });

  test("a PR title passed as LEAK_SCAN_TEXT is scanned", () => {
    const { repo, env } = makeRepo();
    for (const [title, rule] of [[`fix for C07AB12${"CD3E"} owners`, "slack-real-looking-id"], [`${EMP} rollout`, "employer-name"]] as const) {
      const r = sh(repo, "bin/leak-scan.sh meta --no-banner --redact -v", { ...env, LEAK_SCAN_TEXT: title });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(rule);
    }
    expect(sh(repo, "bin/leak-scan.sh meta --no-banner --redact -v", { ...env, LEAK_SCAN_TEXT: "leak guard: scan ref names" }).out).toContain("no leaks found");
  });

  test("user group and file ids are flagged", () => {
    const { repo, env } = makeRepo();
    for (const text of [`Hey <!subteam^S07AB12${"CD3E"}> please`, `file F07AB12${"CD3E"} uploaded`]) {
      writeFileSync(join(repo, "s.txt"), `${text}\n`);
      expect(sh(repo, "bin/leak-scan.sh dir s.txt --no-banner --redact -v", env).out).toContain("slack-real-looking-id");
    }
  });

  test("pre-push decodes a UTF-16 file before scanning it", () => {
    const { repo, env } = makeRepo();
    for (const [name, bom] of [["le.txt", true], ["nobom.txt", false]] as const) {
      const text = Buffer.from(`owner U07AB12${"CD3E"} at ${EMP}\n`, "utf16le");
      writeFileSync(join(repo, name), bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), text]) : text);
      const r = sh(repo, `git checkout -q main && git checkout -qB u16-${name.replace(".txt", "")} && git add ${name} && git commit -qm u16 --no-verify && git push origin HEAD`, env);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("slack-real-looking-id");
      sh(repo, "git checkout -q main", env);
    }
  });

  test("a BOM-less UTF-16 file with curly quotes or an emoji is decoded", () => {
    const { repo, env } = makeRepo();
    const body = `Don’t share — \u{1F600} owner U07AB12${"CD3E"} at ${EMP}\n`;
    for (const [name, buf] of [["le2.txt", Buffer.from(body, "utf16le")], ["be2.txt", Buffer.from(body, "utf16le").swap16()]] as const) {
      writeFileSync(join(repo, name), buf);
      const r = sh(repo, `git checkout -q main && git checkout -qB q-${name.replace(".txt", "")} && git add ${name} && git commit -qm q --no-verify && git push origin HEAD`, env);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("slack-real-looking-id");
      sh(repo, "git checkout -q main", env);
    }
  });

  test("pre-push reads a merged signed tag's text from the mergetag header", () => {
    const { repo, env } = makeRepo();
    const key = join(repo, "..", "sign");
    expect(sh(repo, `ssh-keygen -q -t ed25519 -N '' -f '${key}' && git config gpg.format ssh && git config user.signingkey '${key}.pub'`, env).code).toBe(0);
    const r = sh(
      repo,
      `git checkout -qb side && echo s > s.txt && git add s.txt && git commit -qm s --no-verify && git checkout -q main && git tag -s rel -m "asked in U07AB12${"CD3E"}" side && git merge -q --no-ff -m "merge rel" rel && git tag -d rel >/dev/null && git cat-file commit HEAD | grep -q mergetag && git push origin main`,
      env,
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("slack-real-looking-id");
  });

  test("a mergetag line indented like a commit message is still read", () => {
    const { repo, env } = makeRepo();
    const key = join(repo, "..", "sign");
    expect(sh(repo, `ssh-keygen -q -t ed25519 -N '' -f '${key}' && git config gpg.format ssh && git config user.signingkey '${key}.pub'`, env).code).toBe(0);
    const msg = join(repo, "..", "tagmsg");
    writeFileSync(msg, `Notes\n\n- fixes\n    - reported in U07AB12${"CD3F"}\n`);
    const r = sh(repo, `git checkout -qb side && echo s > s.txt && git add s.txt && git commit -qm s --no-verify && git checkout -q main && git tag -s rel -F '${msg}' side && git merge -q --no-ff -m "merge rel" rel && git tag -d rel >/dev/null && git push origin main`, env);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("slack-real-looking-id");
  });

  test("BOM-less UTF-16 that opens with Cyrillic or CJK is decoded", () => {
    const { repo, env } = makeRepo();
    const lead = ["Привет, как дела?\n".repeat(5), "こんにちは、世界。\n".repeat(5)];
    let i = 0;
    for (const text of lead) {
      const le = Buffer.from(`${text}owner U07AB12${"CD3N"}\n`, "utf16le");
      for (const buf of [le, Buffer.from(le).swap16()]) {
        const name = `n${i++}.txt`;
        writeFileSync(join(repo, name), buf);
        const r = sh(repo, `git checkout -q main && git checkout -qB s-${name.replace(".txt", "")} && git add ${name} && git commit -qm n --no-verify && git push origin HEAD`, env);
        expect(r.code).not.toBe(0);
        expect(r.out).toContain("slack-real-looking-id");
        sh(repo, "git checkout -q main", env);
      }
    }
  });

  test("pre-push reads an annotated tag pushed by its object id", () => {
    const { repo, env } = makeRepo();
    const sha = sh(repo, `git tag -a v13 -m "asked in U07AB12${"CD3E"}" && git rev-parse v13 && git tag -d v13 >/dev/null`, env).out.trim().split("\n")[0];
    const r = sh(repo, `git push origin ${sha}:refs/tags/v13`, env);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("slack-real-looking-id");
  });

  test("pre-push skips with a warning when gitleaks is missing", () => {
    const { repo, env } = makeRepo();
    const r = sh(repo, `PATH=/usr/bin:/bin git push origin main`, env);
    expect(r.code).toBe(0);
  });
});
