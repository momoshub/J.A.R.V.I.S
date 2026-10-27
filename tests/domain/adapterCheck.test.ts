import { describe, expect, test } from "bun:test";
import { parseManifest } from "../../src/domain/adapter.ts";
import { ALWAYS_ON_BUDGET, checkAdapterFiles, describeCheck } from "../../src/domain/adapterCheck.ts";

const manifest = parseManifest({
  template: { id: "mem", version: "1.0" },
  exports: { context: "ADAPTER.md", skills: "skills" },
  structure: {
    learnable: [
      { path: "ADAPTER.md", format: { max_bytes: 100 } },
      { path: "memory/NOTES.md" },
      { path: "memory/people/*.md", format: { max_files: 1 } },
      { path: "skills/*/SKILL.md", format: { frontmatter: ["description"] } },
    ],
    fixed: ["README.md"],
  },
});

const files = (entries: Record<string, string>) => new Map(Object.entries(entries));
const base = { "ADAPTER.md": "# Policy\n- be clear\n" };
const check = (entries: Record<string, string>, rendered = "", budget = ALWAYS_ON_BUDGET) =>
  checkAdapterFiles(manifest, files({ ...base, ...entries }), rendered, budget);

describe("checkAdapterFiles", () => {
  test("a clean tree passes", () => {
    expect(check({ "memory/NOTES.md": "- a fact", "README.md": "anything" }).ok).toBe(true);
  });

  test("the policy must exist - it is the one required export", () => {
    const result = checkAdapterFiles(manifest, files({ "memory/NOTES.md": "x" }), "");
    expect(result.violations.join()).toContain("ADAPTER.md is missing");
  });

  test("a file nobody declared is refused rather than quietly carried", () => {
    expect(check({ "memory/stray.md": "x" }).violations.join()).toContain("not declared in structure.learnable");
  });

  test("a fixed file is allowed without being learnable", () => {
    expect(check({ "README.md": "docs" }).ok).toBe(true);
  });

  test("the declared byte ceiling is enforced", () => {
    expect(check({ "ADAPTER.md": "x".repeat(200) }).violations.join()).toContain("over the 100 declared");
  });

  test("the declared file count is enforced", () => {
    const result = check({ "memory/people/U1.md": "a", "memory/people/U2.md": "b" });
    expect(result.violations.join()).toContain("over the 1 declared");
  });

  test("a skill without a description is refused - it could never be found", () => {
    expect(check({ "skills/rel/SKILL.md": "no frontmatter" }).violations.join()).toContain("description:");
  });

  test("a skill directory with no SKILL.md is not a skill", () => {
    const result = check({ "skills/rel/notes.md": "x" });
    expect(result.violations.join()).toContain("has no SKILL.md");
  });

  test("a file sitting in skills/ is not a skill directory called README.md", () => {
    // the first thing the gate did on real data was refuse the adapter over its
    // own layout README
    expect(check({ "skills/README.md": "what goes in here" }).ok).toBe(true);
  });

  test("a scoped note not named for a Slack id is refused", () => {
    // it would load for nobody, which is worse than not keeping it at all
    expect(check({ "memory/people/kai.md": "x" }).violations.join()).toContain("nothing would ever load it");
  });

  test("the always-on budget is over the TOTAL, which no per-file cap catches", () => {
    const result = check({ "memory/NOTES.md": "fine" }, "x".repeat(50), 20);
    expect(result.ok).toBe(false);
    expect(result.violations.join()).toContain("always-on block is 50 bytes");
    expect(result.violations.join()).toContain("scope a note");
  });
});

describe("describeCheck", () => {
  test("it says so plainly when there is nothing wrong", () => {
    expect(describeCheck({ ok: true, violations: [] })).toContain("passes");
  });

  test("one line per violation", () => {
    expect(describeCheck({ ok: false, violations: ["a", "b"] })).toBe("- a\n- b");
  });
});
