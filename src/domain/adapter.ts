/**
 * Memory as a checked, versioned directory instead of a list of rows.
 *
 * What this replaces: a `learnings` table that only ever grew. Every fact it
 * held was rendered into every prompt, in every channel, forever - so the list
 * carried a fact and its own retraction side by side ("X is not used for
 * preprod" directly above "Correction: X IS used for preprod"), two wordings of
 * the same instruction nobody had merged, and a dozen facts about one repo that
 * loaded into conversations about lunch. Nothing ever removed anything, because
 * removing needed a human to notice.
 *
 * The shape here is Hermit's harness adapter (Infini-AI-Lab/hermit), which is
 * built for exactly this: H = (p, G, K, M).
 *
 * - `p`, the policy - ADAPTER.md. Always-on learned rules. Deliberately small.
 * - `M`, the memory - memory/NOTES.md plus files scoped to one person or one
 *   channel, loaded only where they apply.
 * - `K`, the skills - skills/<name>/SKILL.md, each with a one-line description.
 *   Only the descriptions are always-on; the body is read when it is relevant.
 *   This is where anything procedural or repo-shaped belongs.
 * - `G`, the sub-agents - agents/<name>.md. Reserved; nothing uses them yet.
 *
 * The directory is a real Hermit adapter, not a lookalike: `adapter.yaml`
 * declares the exports and the per-path limits, and `hermit`'s own loader reads
 * it. That is the point of borrowing the format rather than inventing one - the
 * same directory this file renders can be checked, trained and deployed by the
 * framework without a conversion step.
 *
 * Pure: this module is given file contents and returns strings. Reading and
 * writing the directory is `infrastructure/adapter/adapterStore.ts`.
 */

/** The manifest fields the bot actually reads, parsed from `adapter.yaml`. */
export type AdapterManifest = {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** Always `ADAPTER.md`; Hermit fixes the name and so do we. */
  readonly context: string;
  /** Directory of `<name>/SKILL.md`, when the adapter exports skills. */
  readonly skills?: string;
  /** Directory of sub-agent Markdown files, when it exports any. */
  readonly agents?: string;
  /** Declared ceilings, by path glob, from `structure.learnable`. */
  readonly limits: readonly AdapterLimit[];
  /** Paths the adapter carries unchanged - the gate refuses a rewrite of these. */
  readonly fixed: readonly string[];
};

/** One `structure.learnable` entry: what may be written, and how big it may get. */
export type AdapterLimit = {
  readonly path: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  /** Frontmatter keys a file matching this glob must carry. */
  readonly frontmatter: readonly string[];
};

/** A skill: on-demand knowledge, indexed by description and read when relevant. */
export type AdapterSkill = {
  readonly name: string;
  readonly description: string;
  /** Path to SKILL.md, relative to the adapter root. */
  readonly path: string;
};

/** The adapter as the prompt builder needs it. */
export type Adapter = {
  readonly manifest: AdapterManifest;
  /** ADAPTER.md body - the always-on policy. */
  readonly policy: string;
  /** memory/NOTES.md body - always-on notes. */
  readonly notes: string;
  /** Notes about one person, by Slack id. Loaded when they are in the room. */
  readonly people: ReadonlyMap<string, string>;
  /** Notes about one channel, by channel id. Loaded only in that channel. */
  readonly channels: ReadonlyMap<string, string>;
  readonly skills: readonly AdapterSkill[];
  /** Absolute path of the adapter root, so a skill can be pointed at. */
  readonly root: string;
};

/** Where in the conversation the prompt is being built, for scope resolution. */
export type AdapterScope = {
  readonly channelId?: string;
  readonly participantIds?: readonly string[];
  /**
   * Whether this turn can actually open the adapter's files.
   *
   * A skill is an index entry plus a path to read on demand, which only works
   * for a turn that may read that path. Sandboxed roles run in a fixed cwd with
   * an allow-list and no permission prompt, so a read outside it fails - and an
   * index of things it cannot open is worse than no index: it is a list of
   * promises the turn will break. They keep the policy and the notes, which are
   * rendered inline. Defaults to true.
   */
  readonly canReadFiles?: boolean;
};

export const MANIFEST_FILE = "adapter.yaml";
export const POLICY_FILE = "ADAPTER.md";
export const NOTES_FILE = "memory/NOTES.md";
export const PEOPLE_DIR = "memory/people";
export const CHANNELS_DIR = "memory/channels";
export const SKILLS_DIR = "skills";
export const AGENTS_DIR = "agents";

/** Slack ids are the filenames under memory/people and memory/channels. */
const ID_PATTERN = /^[A-Z0-9]+$/;

/** A heading-only or empty body carries nothing; do not spend prompt on it. */
export const isBlank = (body: string): boolean =>
  body
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("")
    .trim().length === 0;

const asNumber = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Read `adapter.yaml`, already parsed from YAML into a plain object.
 *
 * Strict on the fields that matter and quiet about the rest: Hermit owns this
 * file too, and a section the framework adds later must not stop the bot from
 * booting.
 */
export const parseManifest = (raw: unknown): AdapterManifest => {
  if (typeof raw !== "object" || raw === null) throw new Error("adapter.yaml must be a mapping");
  const data = raw as Record<string, unknown>;
  const template = data.template;
  if (typeof template !== "object" || template === null) {
    throw new Error("adapter.yaml needs a template section");
  }
  const t = template as Record<string, unknown>;
  const id = typeof t.id === "string" ? t.id : "";
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error("template.id must be a lowercase slug");
  const version = typeof t.version === "string" && t.version.trim() ? t.version.trim() : "";
  if (!version) throw new Error("template.version must be a nonempty string");

  const exports = data.exports;
  if (typeof exports !== "object" || exports === null) {
    throw new Error("adapter.yaml needs an exports section");
  }
  const e = exports as Record<string, unknown>;
  const context = typeof e.context === "string" ? e.context : POLICY_FILE;
  if (context !== POLICY_FILE) throw new Error(`the context is always ${POLICY_FILE}`);

  const structure = (data.structure ?? {}) as Record<string, unknown>;
  const limits: AdapterLimit[] = [];
  for (const item of Array.isArray(structure.learnable) ? structure.learnable : []) {
    if (typeof item === "string") {
      limits.push({ path: item, frontmatter: [] });
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.path !== "string") continue;
    const fmt = (entry.format ?? {}) as Record<string, unknown>;
    limits.push({
      path: entry.path,
      maxBytes: asNumber(fmt.max_bytes),
      maxFiles: asNumber(fmt.max_files),
      frontmatter: asStringArray(fmt.frontmatter),
    });
  }

  return {
    id,
    fixed: asStringArray(structure.fixed),
    name: typeof t.name === "string" && t.name.trim() ? t.name.trim() : id,
    version,
    context,
    skills: typeof e.skills === "string" ? e.skills : undefined,
    agents: typeof e.agents === "string" ? e.agents : undefined,
    limits,
  };
};

/**
 * Glob match for the patterns `structure.learnable` uses, matching Hermit's own
 * rules: `**` crosses directories, `*` and `?` do not, and a directory pattern
 * covers everything beneath it.
 */
export const matchesGlob = (rel: string, pattern: string): boolean => {
  const build = (p: string): RegExp => {
    let out = "";
    let i = 0;
    while (i < p.length) {
      if (p.startsWith("**/", i)) {
        out += "(?:.*/)?";
        i += 3;
      } else if (p.startsWith("**", i)) {
        out += ".*";
        i += 2;
      } else if (p[i] === "*") {
        out += "[^/]*";
        i += 1;
      } else if (p[i] === "?") {
        out += "[^/]";
        i += 1;
      } else {
        out += p[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        i += 1;
      }
    }
    return new RegExp(`${out}$`);
  };
  const trimmed = pattern.replace(/\/+$/, "");
  return build(trimmed).test(rel) || build(`${trimmed}/**`).test(rel);
};

/** Frontmatter of a Markdown file, as a flat string map. Values are not parsed. */
export const frontmatter = (text: string): Record<string, string> => {
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4);
  if (end === -1) return {};
  const out: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim().replace(/^["']|["']$/g, "");
    if (key) out[key] = value;
  }
  return out;
};

/** The body of a Markdown file, with any frontmatter removed. */
export const body = (text: string): string => {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---", 4);
  return end === -1 ? text : text.slice(end + 4).replace(/^-*\n/, "");
};

/** The id a scoped memory file is named for, or undefined when it is not one. */
export const scopedId = (rel: string, dir: string): string | undefined => {
  if (!rel.startsWith(`${dir}/`)) return undefined;
  const name = rel.slice(dir.length + 1);
  if (name.includes("/") || !name.endsWith(".md")) return undefined;
  const id = name.slice(0, -3);
  return ID_PATTERN.test(id) ? id : undefined;
};

/**
 * The always-on part of the adapter: the policy and the skill index.
 *
 * Kept separate from the scoped memory because this is what the session
 * fingerprint is taken over. A rule changing is a reason to abandon a running
 * session; a note being added is not - the same line drawn for `learnings`,
 * and for the same reason, which is that every open thread would otherwise
 * reset whenever anybody taught the bot anything.
 */
export const adapterRules = (adapter: Adapter): string => {
  const parts: string[] = [];
  if (!isBlank(adapter.policy)) parts.push(adapter.policy.trim());
  const index = adapter.skills
    .map((s) => `${s.name}: ${s.description}`)
    .join("\n");
  if (index) parts.push(index);
  return parts.join("\n\n");
};

const section = (title: string, text: string): string =>
  isBlank(text) ? "" : `\n\n${title}\n${text.trim()}`;

/**
 * Render the adapter into the system prompt for one conversation.
 *
 * Only what applies here: the policy and global notes always, a person's notes
 * when they are in the room, a channel's notes in that channel. Skills are an
 * index - name, description and where to read the rest - because the whole
 * point of moving repo-shaped knowledge out of the always-on block was to stop
 * paying for it in conversations that have nothing to do with that repo.
 */
export const renderAdapter = (adapter: Adapter, scope: AdapterScope = {}): string => {
  const parts: string[] = [];

  parts.push(section("Things you have learned (treat these as known facts):", adapter.policy));
  parts.push(section("Notes you keep:", adapter.notes));

  const seen = new Set<string>();
  for (const id of scope.participantIds ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const note = adapter.people.get(id);
    if (note) parts.push(section(`What you know about <@${id}>:`, note));
  }

  const channelNote = scope.channelId ? adapter.channels.get(scope.channelId) : undefined;
  if (channelNote) parts.push(section("What you know about this channel:", channelNote));

  if (adapter.skills.length > 0 && scope.canReadFiles !== false) {
    const lines = adapter.skills
      .map((s) => `- *${s.name}* - ${s.description}\n  read: ${adapter.root}/${s.path}`)
      .join("\n");
    parts.push(
      `\n\nWhat you know in depth (read one ONLY when the conversation is actually about it - the description is usually enough to know whether it is):\n${lines}`,
    );
  }

  return parts.join("");
};
