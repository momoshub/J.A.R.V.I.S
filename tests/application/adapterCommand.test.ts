import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createLearningsRepo } from "../../src/infrastructure/db/learningsRepo.ts";
import { createAdapterRevisionRepo } from "../../src/infrastructure/db/adapterRevisionRepo.ts";
import { createAdapterStore } from "../../src/infrastructure/adapter/adapterStore.ts";
import { dispatchCommand, type CommandDeps } from "../../src/application/commands.ts";
import type { AllowedUser } from "../../src/domain/types.ts";

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
  fixed:
    - README.md
`;

const OWNER = "U0OWNER";
const actor: AllowedUser = { slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "system", createdAt: 0 };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const deps = (withAdapter = true): CommandDeps => {
  const db = openDatabase(":memory:");
  const root = mkdtempSync(join(tmpdir(), "adapter-cmd-"));
  dirs.push(root);
  if (withAdapter) {
    for (const [rel, content] of Object.entries({
      "adapter.yaml": MANIFEST,
      "ADAPTER.md": "# Policy\n- be clear\n",
      "memory/NOTES.md": "# Notes\n",
      "README.md": "docs",
    })) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
  }
  return {
    users: createUserRepo(db),
    messages: createMessageRepo(db),
    learnings: createLearningsRepo(db),
    adapterStore: createAdapterStore(root),
    adapterRevisions: createAdapterRevisionRepo(db),
    adapterBudget: () => 8000,
    ownerSlackId: OWNER,
    clock: () => 1_700_000_000_000,
  };
};

const run = (d: CommandDeps, line: string) => dispatchCommand(d, actor, "C1", line, { prefix: "X/jv" });

describe("the adapter command", () => {
  test("status reports what memory costs every turn", async () => {
    expect(await run(deps(), "adapter")).toContain("always-on");
  });

  test("check runs the gate without changing anything", async () => {
    const d = deps();
    const before = d.adapterStore?.files().size;
    expect(await run(d, "adapter check")).toContain("passes");
    expect(d.adapterStore?.files().size).toBe(before as number);
  });

  test("history is empty until something is committed, then lists it", async () => {
    const d = deps();
    expect(await run(d, "adapter history")).toContain("No revisions yet");
    await run(d, "learn the team ships on Fridays");
    expect(await run(d, "adapter history")).toContain("learn: the team ships on Fridays");
  });

  test("migrate moves the flat list over and says to refine it", async () => {
    const d = deps();
    d.learnings?.add("an old fact", OWNER, 0);
    const out = await run(d, "adapter migrate");
    expect(out).toContain("Moved 1 learnings");
    expect(out).toContain("adapter refine");
    expect(d.adapterStore?.load().notes).toContain("an old fact");
  });

  test("revert puts a previous state back", async () => {
    const d = deps();
    await run(d, "learn first");
    await run(d, "learn second");
    expect(d.adapterStore?.load().notes).toContain("second");

    const out = await run(d, "adapter revert 1");
    expect(out).toContain("Reverted to #1");
    expect(d.adapterStore?.load().notes).toContain("first");
    expect(d.adapterStore?.load().notes).not.toContain("second");
  });

  test("revert without an id says which command lists them", async () => {
    expect(await run(deps(), "adapter revert")).toContain("adapter history");
  });

  test("an unknown subcommand lists the real ones", async () => {
    expect(await run(deps(), "adapter frobnicate")).toContain("status");
  });

  test("with no adapter configured it says so plainly", async () => {
    expect(await run(deps(false), "adapter")).toContain("No memory adapter is configured");
  });
});

describe("learn, with an adapter", () => {
  test("it writes to the adapter, not the old table", async () => {
    const d = deps();
    expect(await run(d, "learn the tracker lives in Notion")).toContain("Learned it");
    expect(d.adapterStore?.load().notes).toContain("the tracker lives in Notion");
    expect(d.learnings?.list().length).toBe(0);
  });

  test("learnings shows what the adapter holds", async () => {
    const d = deps();
    await run(d, "learn a durable fact");
    const out = await run(d, "learnings");
    expect(out).toContain("a durable fact");
    expect(out).toContain("be clear");
  });

  test("relearn and unlearn point at refine instead of pretending to work", async () => {
    // the numbered ids they edit do not exist any more
    const d = deps();
    expect(await run(d, "relearn 1 something")).toContain("adapter refine");
    expect(await run(d, "unlearn 1")).toContain("adapter refine");
  });

  test("without an adapter the old table still works", async () => {
    const d = deps(false);
    expect(await run(d, "learn an old-style fact")).toContain("#1");
    expect(d.learnings?.list()[0]?.content).toBe("an old-style fact");
  });
});
