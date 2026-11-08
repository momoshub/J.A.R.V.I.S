import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt, buildSystemPromptParts } from "../../src/domain/personality.ts";
import { GUIDE_SUMMARIES, guideFile } from "../../src/domain/promptGuides.ts";
import { promptFingerprint } from "../../src/domain/promptFingerprint.ts";
import { writeGuides } from "../../src/infrastructure/system/guideWriter.ts";

const full = {
  botName: "Jarvis",
  base: "persona",
  learnings: [],
  logSources: ["grafana"],
  grafanaGetScript: "/g.sh",
  canRaiseTickets: true,
  commandPrefix: "X/jv",
  macUiScript: "/m.js",
  desktopScript: "/d.ts",
  kitUrl: "http://kit",
  runScript: "/r.sh",
  runUrl: "http://run",
  runTicket: "t",
  canWatch: true,
};

describe("how-to guides", () => {
  test("without a guide dir every block stays inline, as before", () => {
    const { prompt, guides } = buildSystemPromptParts(full);
    expect(guides).toEqual([]);
    expect(prompt).toContain("Driving a desktop app");
    expect(prompt).toContain("Waiting for something to finish:");
    expect(prompt).toBe(buildSystemPrompt(full));
  });

  test("with one, the procedures leave the prompt for a one-line index", () => {
    const inline = buildSystemPrompt(full);
    const { prompt, guides } = buildSystemPromptParts({ ...full, guideDir: "/gd" });
    expect(guides.map((g): string => g.slug).sort()).toEqual(
      ["block-kit", "credential-gap", "desktop", "investigate", "parallel", "tickets", "waiting"].sort(),
    );
    for (const heading of [
      "Looking things up when something is wrong",
      "Driving a desktop app",
      "Interactive Block Kit",
      "A message with several questions in it:",
      "When you cannot see something:",
      "Waiting for something to finish:",
    ]) {
      expect(prompt).not.toContain(heading);
      expect(guides.some((g) => g.body.includes(heading))).toBe(true);
    }
    for (const g of guides) {
      expect(prompt).toContain(`read: /gd/${guideFile(g)}`);
      expect(prompt).toContain(GUIDE_SUMMARIES[g.slug]);
    }
    // the guards that must hold unread stay always on
    expect(prompt).toContain("NEVER cloudwatch");
    expect(prompt).toContain("set a `watch` instead");
    // the commands themselves and the closing rules are still there
    expect(prompt).toContain("Running my own commands");
    expect(prompt.trimEnd().endsWith(inline.slice(inline.indexOf("Identity lock")).trimEnd())).toBe(true);
    expect(prompt.length).toBeLessThan(inline.length / 2);
  });

  test("a turn that cannot read files keeps everything inline", () => {
    const { prompt, guides } = buildSystemPromptParts({ ...full, guideDir: "/gd", adapterScope: { canReadFiles: false } });
    expect(guides).toEqual([]);
    expect(prompt).toContain("Driving a desktop app");
  });

  test("a block this turn would not get is not a guide either", () => {
    const { guides } = buildSystemPromptParts({ ...full, guideDir: "/gd", macUiScript: undefined, desktopScript: undefined, canWatch: false });
    expect(guides.some((g) => g.slug === "desktop" || g.slug === "waiting")).toBe(false);
  });

  test("the writer puts each guide at the path the prompt names, once", () => {
    const dir = mkdtempSync(join(tmpdir(), "guides-"));
    const { guides } = buildSystemPromptParts({ ...full, guideDir: dir });
    writeGuides(dir, guides);
    writeGuides(dir, guides);
    expect(readdirSync(dir).sort()).toEqual(guides.map(guideFile).sort());
    for (const g of guides) expect(readFileSync(join(dir, guideFile(g)), "utf8")).toBe(`${g.body}\n`);
  });

  test("a changed guard line changes the fingerprint", () => {
    const before = promptFingerprint(buildSystemPrompt as never, "persona");
    const saved = GUIDE_SUMMARIES.desktop;
    (GUIDE_SUMMARIES as Record<string, string>).desktop = `${saved} changed`;
    try {
      expect(promptFingerprint(buildSystemPrompt as never, "persona")).not.toBe(before);
    } finally {
      (GUIDE_SUMMARIES as Record<string, string>).desktop = saved;
    }
  });
});
