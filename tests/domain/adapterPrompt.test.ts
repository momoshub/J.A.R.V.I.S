import { guideIndexForFingerprint } from "../../src/domain/promptGuides.ts";
import { describe, expect, test } from "bun:test";
import { type Adapter, adapterRules, parseManifest } from "../../src/domain/adapter.ts";
import { buildSystemPrompt } from "../../src/domain/personality.ts";
import { createHash } from "node:crypto";
import { promptFingerprint } from "../../src/domain/promptFingerprint.ts";
import { selfUpdateRules } from "../../src/domain/selfUpdate.ts";

const adapter = (over: Partial<Adapter> = {}): Adapter => ({
  manifest: parseManifest({
    template: { id: "mem", version: "1.0" },
    exports: { context: "ADAPTER.md" },
    structure: { learnable: ["ADAPTER.md"] },
  }),
  policy: "- never post secrets",
  notes: "- the tracker lives in Notion",
  people: new Map([["U7", "- address them formally"]]),
  channels: new Map([["C9", "- English only in here"]]),
  skills: [{ name: "releases", description: "how releases are cut", path: "skills/releases/SKILL.md" }],
  root: "/adapter",
  ...over,
});

describe("buildSystemPrompt with an adapter", () => {
  test("the adapter replaces the flat learnings block", () => {
    const prompt = buildSystemPrompt({
      learnings: ["a legacy row nobody migrated"],
      adapter: adapter(),
    });
    expect(prompt).toContain("never post secrets");
    expect(prompt).not.toContain("a legacy row nobody migrated");
  });

  test("without an adapter the flat list still works, unchanged", () => {
    // an instance that has not migrated must keep behaving exactly as before
    const prompt = buildSystemPrompt({ learnings: ["the old way"] });
    expect(prompt).toContain("Things you have learned");
    expect(prompt).toContain("the old way");
  });

  test("scoped memory follows who is in the room", () => {
    const here = buildSystemPrompt({
      learnings: [],
      adapter: adapter(),
      adapterScope: { channelId: "C9", participantIds: ["U7"] },
    });
    const elsewhere = buildSystemPrompt({
      learnings: [],
      adapter: adapter(),
      adapterScope: { channelId: "C1", participantIds: ["U2"] },
    });

    expect(here).toContain("address them formally");
    expect(here).toContain("English only in here");
    expect(elsewhere).not.toContain("address them formally");
    expect(elsewhere).not.toContain("English only in here");
  });

  test("a sandboxed turn is not offered skills it could never open", () => {
    // its cwd is fixed and it has no permission prompt, so a path outside it
    // fails - an index of unreadable files is a list of broken promises
    const sandboxed = buildSystemPrompt({
      learnings: [],
      adapter: adapter(),
      adapterScope: { canReadFiles: false },
    });
    expect(sandboxed).not.toContain("how releases are cut");
    // it still gets the policy and the notes, which are rendered inline
    expect(sandboxed).toContain("never post secrets");
    expect(sandboxed).toContain("the tracker lives in Notion");
  });

  test("a skill costs a description in the prompt, not its body", () => {
    const prompt = buildSystemPrompt({ learnings: [], adapter: adapter() });
    expect(prompt).toContain("how releases are cut");
    expect(prompt).toContain("/adapter/skills/releases/SKILL.md");
  });
});

describe("the fingerprint and the adapter", () => {
  const fp = (a: Adapter) => promptFingerprint(buildSystemPrompt as never, "persona", adapterRules(a));

  test("changing the policy reopens live threads", () => {
    // a rule change has to reach a thread that is already running; it only does
    // that by abandoning the session, which only happens if the hash moves
    expect(fp(adapter())).not.toBe(fp(adapter({ policy: "- always post secrets" })));
  });

  test("adding a skill reopens them too - the index is a rule", () => {
    expect(fp(adapter())).not.toBe(fp(adapter({ skills: [] })));
  });

  test("teaching a note does NOT, or every open thread would reset on a `learn`", () => {
    expect(fp(adapter())).toBe(fp(adapter({ notes: "- something completely different" })));
  });

  test("neither does a note about one person or channel", () => {
    expect(fp(adapter())).toBe(fp(adapter({ people: new Map([["U7", "- changed"]]), channels: new Map() })));
  });
});

describe("the fingerprint and the short self-update block", () => {
  test("the short block a turn with a visible skill gets is part of the hash", () => {
    // the sentinels carry no adapter, so the build renders the full block; the
    // short one must be hashed on its own or a change to it never reopens a thread
    const build = () => "prompt";
    const hash = (...parts: string[]) => {
      const h = createHash("sha256");
      for (const p of parts) h.update(p);
      return h.digest("hex").slice(0, 16);
    };
    // with the account split rendered, so a change to that line reopens threads too
    const short = selfUpdateRules("/fp/repo", "/fp/restart", true, { author: "fp-author", reviewer: "fp-reviewer" });
    expect(short).toContain("read the skill in your memory");
    expect(short).toContain("GitHub accounts:");
    // below owner the Orca lines are replaced, so that variant is hashed as well
    const shortAgent = selfUpdateRules("/fp/repo", "/fp/restart", true, { author: "fp-author", reviewer: "fp-reviewer" }, false);
    expect(shortAgent).not.toBe(short);
    expect(promptFingerprint(build, "persona")).toBe(
      hash("prompt", "", short, guideIndexForFingerprint(["grafana", "datadog"]), "prompt", shortAgent, guideIndexForFingerprint(["grafana", "datadog"], false)),
    );
    expect(promptFingerprint(build, "persona")).not.toBe(hash("prompt", ""));
  });
});

describe("self-fixing follows whether a skill can be read", () => {
  const self = { repoPath: "/repo", restartScript: "/bin/restart.sh" };
  const POINTER = "read the skill in your memory about changing your own source";
  const FULL = "holds until no turn is running in any thread";

  test("with visible skills the prompt points at the skill", () => {
    const prompt = buildSystemPrompt({ ...self, adapter: adapter() });
    expect(prompt).toContain(POINTER);
    expect(prompt).not.toContain(FULL);
  });

  test("with no adapter, no skills or skills hidden, the full block stays", () => {
    for (const prompt of [
      buildSystemPrompt({ ...self }),
      buildSystemPrompt({ ...self, adapter: adapter({ skills: [] }) }),
      buildSystemPrompt({ ...self, adapter: adapter(), adapterScope: { canReadFiles: false } }),
    ]) {
      expect(prompt).toContain(FULL);
      expect(prompt).not.toContain(POINTER);
    }
  });
});
