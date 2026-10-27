/**
 * The gate an adapter update must pass before it is committed.
 *
 * `learn` had no gate at all: whatever was handed to it became a fact the bot
 * carried into every conversation forever, and the only way back was a human
 * noticing and typing `unlearn`. Nobody ever did. That is how one list ended up
 * holding a claim and its own correction at the same time.
 *
 * So an update is a proposal, and a proposal is checked. Most of what is
 * checked is declared by the adapter itself, in `structure` - Hermit's own
 * contract, so `hermit check` enforces the same ceilings on the same directory.
 *
 * One rule here is ours and not Hermit's: ALWAYS_ON_BUDGET. The framework caps
 * each file, which stops any one of them running away, but the thing that
 * actually went wrong was the total - every fact always-on, in every channel,
 * growing by one line at a time with nothing ever taking a line out. A per-file
 * cap would never have caught that. A budget on what loads unconditionally is
 * the rule that says: if you want to remember more, scope it or make it a
 * skill.
 */
import {
  type Adapter,
  type AdapterManifest,
  CHANNELS_DIR,
  frontmatter,
  isBlank,
  matchesGlob,
  MANIFEST_FILE,
  NOTES_FILE,
  PEOPLE_DIR,
  POLICY_FILE,
  SKILLS_DIR,
  adapterRules,
  scopedId,
} from "./adapter.ts";

/** Files the framework owns; they are never learnable and never a violation. */
const FRAMEWORK_FILES: readonly string[] = [MANIFEST_FILE, "CARD.md"];

/**
 * Ceiling on everything that loads into EVERY prompt: the policy, the global
 * notes and the skill index. Scoped memory and skill bodies do not count - they
 * only load where they apply, which is the whole point of having them.
 */
export const ALWAYS_ON_BUDGET = 8_000;

export type AdapterCheck = {
  readonly ok: boolean;
  readonly violations: readonly string[];
};

const bytes = (s: string): number => new TextEncoder().encode(s).length;

/**
 * Check a proposed set of files (relative path -> content) against the manifest.
 *
 * `rendered` is the always-on text the proposal would produce; it is passed in
 * rather than recomputed so the budget is measured on exactly what the prompt
 * builder will emit.
 */
export const checkAdapterFiles = (
  manifest: AdapterManifest,
  files: ReadonlyMap<string, string>,
  rendered: string,
  budget: number = ALWAYS_ON_BUDGET,
): AdapterCheck => {
  const violations: string[] = [];

  if (!files.has(POLICY_FILE)) violations.push(`${POLICY_FILE} is missing - every adapter exports its policy`);

  const counts = new Map<string, number>();
  for (const [path, content] of files) {
    if (FRAMEWORK_FILES.includes(path)) continue;
    if (manifest.fixed.some((p) => matchesGlob(path, p))) continue;

    const limit = manifest.limits.find((l) => matchesGlob(path, l.path));
    if (!limit) {
      violations.push(`${path} is not declared in structure.learnable - add it to ${MANIFEST_FILE} or remove it`);
      continue;
    }
    counts.set(limit.path, (counts.get(limit.path) ?? 0) + 1);

    if (limit.maxBytes && bytes(content) > limit.maxBytes) {
      violations.push(`${path} is ${bytes(content)} bytes, over the ${limit.maxBytes} declared for ${limit.path}`);
    }
    if (limit.frontmatter.length > 0) {
      const head = frontmatter(content);
      for (const key of limit.frontmatter) {
        if (!head[key]?.trim()) violations.push(`${path} needs a \`${key}:\` in its frontmatter`);
      }
    }
  }

  for (const limit of manifest.limits) {
    const used = counts.get(limit.path) ?? 0;
    if (limit.maxFiles && used > limit.maxFiles) {
      violations.push(`${used} files match ${limit.path}, over the ${limit.maxFiles} declared`);
    }
  }

  // A scoped note filed under a name that is not an id would never load: the
  // prompt looks it up by the Slack id of whoever is present. Silently dead
  // memory is worse than no memory, so refuse it.
  for (const path of files.keys()) {
    for (const dir of [PEOPLE_DIR, CHANNELS_DIR]) {
      if (path.startsWith(`${dir}/`) && !scopedId(path, dir)) {
        violations.push(`${path} is not named for a Slack id, so nothing would ever load it`);
      }
    }
  }

  const skillDirs = new Map<string, boolean>();
  for (const path of files.keys()) {
    if (!path.startsWith(`${SKILLS_DIR}/`)) continue;
    const name = path.slice(SKILLS_DIR.length + 1).split("/")[0];
    // A file sitting directly in skills/ - the README that explains the layout
    // - is not a skill called "README.md". Only a directory is a skill.
    if (!name || path === `${SKILLS_DIR}/${name}`) continue;
    skillDirs.set(name, skillDirs.get(name) || path === `${SKILLS_DIR}/${name}/SKILL.md`);
  }
  for (const [name, hasSkillFile] of skillDirs) {
    if (!hasSkillFile) violations.push(`${SKILLS_DIR}/${name} has no SKILL.md, so it is not a skill`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) violations.push(`${SKILLS_DIR}/${name} is not a lowercase slug`);
  }

  const size = bytes(rendered);
  if (size > budget) {
    violations.push(
      `the always-on block is ${size} bytes, over the ${budget} budget - scope a note to a person or channel, or move it into a skill`,
    );
  }

  return { ok: violations.length === 0, violations };
};

/** The same check, over a loaded adapter rather than a proposal. */
export const checkAdapter = (
  adapter: Adapter,
  files: ReadonlyMap<string, string>,
  budget: number = ALWAYS_ON_BUDGET,
): AdapterCheck => {
  const alwaysOn = [adapterRules(adapter), isBlank(adapter.notes) ? "" : adapter.notes].join("\n\n");
  return checkAdapterFiles(adapter.manifest, files, alwaysOn, budget);
};

/** One line per violation, for a Slack reply. */
export const describeCheck = (check: AdapterCheck): string =>
  check.ok ? "The adapter passes its checks." : check.violations.map((v) => `- ${v}`).join("\n");

export { NOTES_FILE };
