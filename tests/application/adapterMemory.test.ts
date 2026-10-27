import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createAdapterStore } from "../../src/infrastructure/adapter/adapterStore.ts";
import { createAdapterRevisionRepo } from "../../src/infrastructure/db/adapterRevisionRepo.ts";
import { migrate } from "../../src/infrastructure/db/schema.ts";
import {
  type AdapterDeps,
  adapterStatus,
  commitAdapter,
  INBOX_HEADING,
  migrateLearnings,
  rememberFact,
  revertAdapter,
} from "../../src/application/adapterMemory.ts";

const MANIFEST = `
template:
  id: mem
  version: "1.0"
  name: Memory
exports:
  context: ADAPTER.md
  skills: skills
structure:
  learnable:
    - path: ADAPTER.md
      format: {max_bytes: 8000}
    - path: memory/NOTES.md
      format: {max_bytes: 8000}
    - path: memory/people/*.md
      format: {max_bytes: 8000}
    - path: memory/channels/*.md
      format: {max_bytes: 8000}
    - path: skills/*/SKILL.md
      format: {frontmatter: [description]}
  fixed:
    - README.md
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const setup = (files: Record<string, string> = {}, budget?: number): AdapterDeps => {
  const root = mkdtempSync(join(tmpdir(), "adapter-test-"));
  dirs.push(root);
  const all = { "adapter.yaml": MANIFEST, "ADAPTER.md": "# Policy\n", "README.md": "docs", ...files };
  for (const [rel, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  const db = new Database(":memory:");
  migrate(db);
  return {
    store: createAdapterStore(root),
    revisions: createAdapterRevisionRepo(db),
    clock: () => 1_700_000_000_000,
    budget,
  };
};

describe("rememberFact", () => {
  test("a fact lands under the inbox heading and is readable back", () => {
    const deps = setup();
    expect(rememberFact(deps, "the team ships on Fridays", { kind: "global" }, "U1").ok).toBe(true);
    const notes = deps.store.load().notes;
    expect(notes).toContain(INBOX_HEADING);
    expect(notes).toContain("the team ships on Fridays");
  });

  test("a person-scoped fact goes to their file and loads only for them", () => {
    const deps = setup();
    rememberFact(deps, "prefers short answers", { kind: "person", id: "U7" }, "U1");
    expect(deps.store.load().people.get("U7")).toContain("prefers short answers");
    expect(deps.store.load().notes).not.toContain("prefers short answers");
  });

  test("a channel-scoped fact goes to the channel's file", () => {
    const deps = setup();
    rememberFact(deps, "English only in here", { kind: "channel", id: "C3" }, "U1");
    expect(deps.store.load().channels.get("C3")).toContain("English only in here");
  });

  test("every fact is a revision, so a bad one can be undone", () => {
    const deps = setup();
    rememberFact(deps, "first", { kind: "global" }, "U1");
    rememberFact(deps, "second", { kind: "global" }, "U1");
    expect(deps.revisions?.list().length).toBe(2);
  });

  test("teaching is never refused for being over budget - it warns instead", () => {
    // the moment "remember this" can fail, people stop telling the bot things
    const deps = setup({ "memory/NOTES.md": `# Notes\n- ${"x".repeat(400)}\n` }, 50);
    const result = rememberFact(deps, "one more", { kind: "global" }, "U1");
    expect(result.ok).toBe(true);
    expect(result.ok && result.warnings.join()).toContain("always-on block");
    expect(deps.store.load().notes).toContain("one more");
  });

  test("nothing to remember is refused", () => {
    expect(rememberFact(setup(), "   ", { kind: "global" }, "U1").ok).toBe(false);
  });
});

describe("commitAdapter", () => {
  test("a proposal that fails the gate leaves the adapter untouched", () => {
    const deps = setup({ "memory/NOTES.md": "# Notes\n- keep me\n" });
    const bad = new Map(deps.store.files());
    bad.set("memory/people/not-an-id.md", "x");
    const result = commitAdapter(deps, bad, { reason: "bad", actor: "U1" });

    expect(result.ok).toBe(false);
    // the live tree is exactly what it was - including the file the proposal added
    expect(deps.store.files().has("memory/people/not-an-id.md")).toBe(false);
    expect(deps.store.load().notes).toContain("keep me");
  });

  test("a refine pass may not rewrite the manifest that declares its own limits", () => {
    const deps = setup();
    const sneaky = new Map(deps.store.files());
    sneaky.set("adapter.yaml", MANIFEST.replace("max_bytes: 8000", "max_bytes: 99999999"));
    const result = commitAdapter(deps, sneaky, { reason: "x", actor: "U1", enforceFixed: true });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.violations.join()).toContain("adapter.yaml may not be changed");
  });

  test("a refine pass may not rewrite a fixed file either", () => {
    const deps = setup();
    const sneaky = new Map(deps.store.files());
    sneaky.set("README.md", "rewritten");
    expect(commitAdapter(deps, sneaky, { reason: "x", actor: "U1", enforceFixed: true }).ok).toBe(false);
  });

  test("a refine pass must come in under budget, unlike teaching", () => {
    const deps = setup({}, 20);
    const over = new Map(deps.store.files());
    over.set("memory/NOTES.md", `# Notes\n- ${"x".repeat(200)}\n`);
    expect(commitAdapter(deps, over, { reason: "x", actor: "U1", enforceBudget: true }).ok).toBe(false);
    expect(commitAdapter(deps, over, { reason: "x", actor: "U1", enforceBudget: false }).ok).toBe(true);
  });
});

describe("migrateLearnings", () => {
  test("every learning arrives, unsorted and unmerged", () => {
    const deps = setup();
    const result = migrateLearnings(deps, ["call them sistur", "call them sistur everywhere"], "U1");

    expect(result.ok).toBe(true);
    const notes = deps.store.load().notes;
    // the duplicate is deliberately carried over: merging is the refine pass's
    // job, done by something that can read them, not a heuristic in a migration
    expect(notes).toContain("call them sistur");
    expect(notes).toContain("call them sistur everywhere");
  });

  test("an empty list is a no-op", () => {
    expect(migrateLearnings(setup(), [], "U1").ok).toBe(true);
  });
});

describe("revertAdapter", () => {
  test("it restores a previous revision and records the restore", () => {
    const deps = setup();
    rememberFact(deps, "first fact", { kind: "global" }, "U1");
    const first = deps.revisions?.list()[0]?.id ?? 0;
    rememberFact(deps, "second fact", { kind: "global" }, "U1");
    expect(deps.store.load().notes).toContain("second fact");

    const result = revertAdapter(deps, first, "U1");
    expect(result.ok).toBe(true);
    expect(deps.store.load().notes).toContain("first fact");
    expect(deps.store.load().notes).not.toContain("second fact");
    expect(deps.revisions?.list()[0]?.reason).toContain(`revert to #${first}`);
  });

  test("reverting to a revision that does not exist says so", () => {
    expect(revertAdapter(setup(), 99, "U1").ok).toBe(false);
  });
});

describe("adapterStatus", () => {
  test("it reports what memory costs every turn", () => {
    const deps = setup({ "memory/people/U9.md": "- a note" });
    const status = adapterStatus(deps);
    expect(status).toContain("always-on");
    expect(status).toContain("1 people");
  });

  test("over budget, it says what to do about it", () => {
    const deps = setup({ "memory/NOTES.md": `# Notes\n- ${"x".repeat(200)}\n` }, 20);
    expect(adapterStatus(deps)).toContain("adapter refine");
  });
});

describe("the staging copy", () => {
  test("a refine pass edits a copy, never the live adapter", () => {
    const deps = setup({ "memory/NOTES.md": "# Notes\n- live\n" });
    const staged = deps.store.stage();
    writeFileSync(join(staged, "memory/NOTES.md"), "# Notes\n- edited\n");

    // nothing has reached the live tree yet
    expect(deps.store.load().notes).toContain("live");

    const result = commitAdapter(deps, deps.store.collect(staged), { reason: "refine", actor: "U1" });
    expect(result.ok).toBe(true);
    expect(deps.store.load().notes).toContain("edited");
    deps.store.discard(staged);
  });
});
