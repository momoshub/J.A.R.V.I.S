import { describe, expect, test } from "bun:test";
import {
  type Adapter,
  adapterRules,
  body,
  frontmatter,
  isBlank,
  matchesGlob,
  parseManifest,
  renderAdapter,
  scopedId,
} from "../../src/domain/adapter.ts";

const manifest = {
  template: { id: "mem", version: "1.0", name: "Memory" },
  exports: { context: "ADAPTER.md", skills: "skills" },
  structure: {
    learnable: [
      { path: "ADAPTER.md", format: { text: true, max_bytes: 8000 } },
      { path: "skills/*/SKILL.md", format: { max_files: 2, frontmatter: ["description"] } },
      "memory/NOTES.md",
    ],
    fixed: ["README.md"],
  },
};

const adapter = (over: Partial<Adapter> = {}): Adapter => ({
  manifest: parseManifest(manifest),
  policy: "- always be clear",
  notes: "- the team ships on Fridays",
  people: new Map([["U1", "- prefers short answers"]]),
  channels: new Map([["C1", "- English only in here"]]),
  skills: [{ name: "releases", description: "how releases are cut", path: "skills/releases/SKILL.md" }],
  root: "/adapter",
  ...over,
});

describe("parseManifest", () => {
  test("reads identity, exports and the declared limits", () => {
    const m = parseManifest(manifest);
    expect(m.id).toBe("mem");
    expect(m.skills).toBe("skills");
    expect(m.fixed).toEqual(["README.md"]);
    expect(m.limits.find((l) => l.path === "ADAPTER.md")?.maxBytes).toBe(8000);
    expect(m.limits.find((l) => l.path === "skills/*/SKILL.md")?.frontmatter).toEqual(["description"]);
  });

  test("a bare string learnable entry is a path with no limits", () => {
    expect(parseManifest(manifest).limits.find((l) => l.path === "memory/NOTES.md")?.maxBytes).toBeUndefined();
  });

  test("it refuses a manifest that renames the context export", () => {
    // Hermit fixes the name; a renamed context would load on one side only
    expect(() => parseManifest({ ...manifest, exports: { context: "OTHER.md" } })).toThrow(/ADAPTER.md/);
  });

  test("it refuses an id that is not a slug", () => {
    expect(() => parseManifest({ ...manifest, template: { id: "Mem Adapter", version: "1" } })).toThrow(/slug/);
  });
});

describe("matchesGlob", () => {
  test("* does not cross a directory, ** does", () => {
    expect(matchesGlob("skills/a/SKILL.md", "skills/*/SKILL.md")).toBe(true);
    expect(matchesGlob("skills/a/b/SKILL.md", "skills/*/SKILL.md")).toBe(false);
    expect(matchesGlob("skills/a/b/SKILL.md", "skills/**/SKILL.md")).toBe(true);
  });

  test("a directory pattern covers what is beneath it", () => {
    expect(matchesGlob("skills/a/scripts/go.sh", "skills")).toBe(true);
  });
});

describe("frontmatter", () => {
  test("reads the keys and strips them from the body", () => {
    const text = '---\nname: releases\ndescription: "how releases are cut"\n---\nThe steps.\n';
    expect(frontmatter(text).description).toBe("how releases are cut");
    expect(body(text).trim()).toBe("The steps.");
  });

  test("a file with no frontmatter is all body", () => {
    expect(frontmatter("# Notes\n- a")).toEqual({});
    expect(body("# Notes\n- a")).toBe("# Notes\n- a");
  });
});

describe("scopedId", () => {
  test("it takes the Slack id from the filename", () => {
    expect(scopedId("memory/people/U123.md", "memory/people")).toBe("U123");
    expect(scopedId("memory/channels/C9.md", "memory/channels")).toBe("C9");
  });

  test("anything that is not an id is not a scope", () => {
    // these are the files that would silently never load again
    expect(scopedId("memory/people/kai.md", "memory/people")).toBeUndefined();
    expect(scopedId("memory/people/nested/U1.md", "memory/people")).toBeUndefined();
  });
});

describe("isBlank", () => {
  test("a heading on its own carries nothing", () => {
    expect(isBlank("# Notes\n\n")).toBe(true);
    expect(isBlank("# Notes\n- something")).toBe(false);
  });
});

describe("renderAdapter", () => {
  test("policy and global notes are always in", () => {
    const out = renderAdapter(adapter());
    expect(out).toContain("always be clear");
    expect(out).toContain("ships on Fridays");
  });

  test("a person's notes load only when they are in the conversation", () => {
    expect(renderAdapter(adapter(), { participantIds: ["U1"] })).toContain("prefers short answers");
    expect(renderAdapter(adapter(), { participantIds: ["U2"] })).not.toContain("prefers short answers");
  });

  test("a channel's notes load only in that channel", () => {
    expect(renderAdapter(adapter(), { channelId: "C1" })).toContain("English only in here");
    expect(renderAdapter(adapter(), { channelId: "C2" })).not.toContain("English only in here");
  });

  test("a skill contributes its description and where to read it, never its body", () => {
    // the whole point of promoting something to a skill: the depth is on demand
    const out = renderAdapter(adapter());
    expect(out).toContain("how releases are cut");
    expect(out).toContain("/adapter/skills/releases/SKILL.md");
  });

  test("an empty section is left out rather than rendered as a heading", () => {
    const out = renderAdapter(adapter({ notes: "# Notes", skills: [] }));
    expect(out).not.toContain("Notes you keep");
    expect(out).not.toContain("What you know in depth");
  });
});

describe("adapterRules", () => {
  test("the policy and the skill index are rules", () => {
    const rules = adapterRules(adapter());
    expect(rules).toContain("always be clear");
    expect(rules).toContain("releases");
  });

  test("notes are not - teaching a fact must not reopen every thread", () => {
    expect(adapterRules(adapter())).toBe(adapterRules(adapter({ notes: "- something else entirely" })));
  });

  test("but a policy change is", () => {
    expect(adapterRules(adapter())).not.toBe(adapterRules(adapter({ policy: "- be terse" })));
  });
});
