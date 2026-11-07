/**
 * The memory adapter: read it, write it, list it.
 *
 * The source of truth is the `adapter_files` table, one row per file. It used
 * to be a directory under `data/adapter`, which the bot wrote and a human had
 * to commit - so git held a copy that drifted from what the bot knew, and read
 * like stale memory left behind after the move to the DB. Revision history
 * sits in the same database (`adapter_revisions`), which is what makes a bad
 * curation a one-line revert instead of an archaeology exercise.
 *
 * The files still have to exist on disk: a skill is read by path, and the
 * browser skill ships scripts that are run by path. So every write re-renders
 * a mirror directory from the rows. The mirror is output, never input -
 * anything edited there is overwritten on the next write or start. It is
 * still a real Hermit adapter, so `hermit check` can be pointed at it.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { DbClient } from "../db/client.ts";
import {
  type Adapter,
  AGENTS_DIR,
  body,
  CHANNELS_DIR,
  frontmatter,
  MANIFEST_FILE,
  NOTES_FILE,
  parseManifest,
  PEOPLE_DIR,
  POLICY_FILE,
  scopedId,
  SKILLS_DIR,
  withoutTitle,
} from "../../domain/adapter.ts";

/** Bun parses YAML natively; the type is not in @types/bun yet. */
const parseYaml = (text: string): unknown =>
  (Bun as unknown as { YAML: { parse: (s: string) => unknown } }).YAML.parse(text);

/** Never part of the adapter, whatever is on disk. */
const IGNORED = new Set([".git", "__pycache__", ".DS_Store", "node_modules"]);

export type AdapterStore = {
  /** True when a manifest is present - without one there is no adapter. */
  readonly exists: () => boolean;
  /** Every file, relative path to content. */
  readonly files: () => Map<string, string>;
  /** The adapter as the prompt builder needs it; throws on a broken manifest. */
  readonly load: () => Adapter;
  /** Replace the directory's contents with exactly these files. */
  readonly write: (files: ReadonlyMap<string, string>) => void;
  /**
   * A throwaway copy of the adapter for a refine pass to edit.
   *
   * The model never writes the live directory. A curation that loses something
   * has to be revertible, and the thing doing the losing cannot also be the
   * thing that decides the write was fine - so it works here, and the command
   * gates what comes back.
   */
  readonly stage: () => string;
  /** Read a staged directory back, same shape as `files()`. */
  readonly collect: (dir: string) => Map<string, string>;
  readonly discard: (dir: string) => void;
  /** The mirror directory - where skills are read from, not where they live. */
  readonly root: string;
};

const walk = (root: string, dir: string, out: string[]): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full).split("\\").join("/"));
  }
};

const readTree = (dir: string): Map<string, string> => {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  const paths: string[] = [];
  walk(dir, dir, paths);
  for (const rel of paths.sort()) out.set(rel, readFileSync(join(dir, rel), "utf8"));
  return out;
};

/** Make `dir` hold exactly `next`: write what changed, remove what is gone. */
const syncTree = (dir: string, next: ReadonlyMap<string, string>): void => {
  const root = resolve(dir);
  const before = readTree(root);
  for (const [rel, content] of next) {
    const full = resolve(root, rel);
    if (!full.startsWith(`${root}/`)) throw new Error(`Refusing to write outside the adapter: ${rel}`);
    if (before.get(rel) === content) continue;
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  for (const rel of before.keys()) {
    if (next.has(rel)) continue;
    rmSync(join(root, rel), { force: true });
  }
  // A curation that empties a skill should not leave its directory behind
  // to be mistaken for one that exists but has lost its SKILL.md.
  for (const sub of [SKILLS_DIR, AGENTS_DIR, PEOPLE_DIR, CHANNELS_DIR]) {
    const full = join(root, sub);
    if (!existsSync(full)) continue;
    for (const entry of readdirSync(full)) {
      const child = join(full, entry);
      if (statSync(child).isDirectory() && readdirSync(child).length === 0) rmSync(child, { recursive: true });
    }
  }
};

/**
 * The store over `db`, mirrored into `mirrorPath`.
 *
 * `importFrom` is the old on-disk adapter: read once, only while the table is
 * still empty, so an instance upgrading from the directory keeps its memory.
 */
export const createAdapterStore = (db: DbClient, mirrorPath: string, importFrom?: string): AdapterStore => {
  const root = resolve(mirrorPath);

  const files = (): Map<string, string> => {
    const rows = db
      .query<{ path: string; content: string }, []>("SELECT path, content FROM adapter_files ORDER BY path")
      .all();
    return new Map(rows.map((r) => [r.path, r.content]));
  };

  const replaceRows = db.transaction((next: ReadonlyMap<string, string>) => {
    db.exec("DELETE FROM adapter_files");
    const insert = db.query("INSERT INTO adapter_files (path, content) VALUES (?, ?)");
    for (const [rel, content] of next) insert.run(rel, content);
  });

  const write = (next: ReadonlyMap<string, string>): void => {
    for (const rel of next.keys()) {
      if (!resolve(root, rel).startsWith(`${root}/`)) throw new Error(`Refusing to write outside the adapter: ${rel}`);
    }
    replaceRows(next);
    syncTree(root, next);
  };

  if (files().size === 0 && importFrom && existsSync(join(importFrom, MANIFEST_FILE))) {
    write(readTree(resolve(importFrom)));
  } else {
    syncTree(root, files());
  }

  const load = (): Adapter => {
    const all = files();
    const manifestText = all.get(MANIFEST_FILE);
    if (manifestText === undefined) throw new Error(`No ${MANIFEST_FILE} in the adapter`);
    const manifest = parseManifest(parseYaml(manifestText));

    const people = new Map<string, string>();
    const channels = new Map<string, string>();
    for (const [rel, content] of all) {
      const person = scopedId(rel, PEOPLE_DIR);
      if (person) people.set(person, withoutTitle(body(content)).trim());
      const channel = scopedId(rel, CHANNELS_DIR);
      if (channel) channels.set(channel, withoutTitle(body(content)).trim());
    }

    const skillsDir = manifest.skills ?? SKILLS_DIR;
    const skills = [...all.keys()]
      .filter((rel) => rel.startsWith(`${skillsDir}/`) && rel.endsWith("/SKILL.md"))
      .map((rel) => {
        const head = frontmatter(all.get(rel) ?? "");
        const name = rel.slice(skillsDir.length + 1, -"/SKILL.md".length);
        return { name: head.name?.trim() || name, description: head.description?.trim() || "", path: rel };
      })
      .filter((s) => s.description)
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      manifest,
      policy: withoutTitle(body(all.get(POLICY_FILE) ?? "")).trim(),
      notes: withoutTitle(body(all.get(NOTES_FILE) ?? "")).trim(),
      people,
      channels,
      skills,
      root,
    };
  };

  return {
    root,
    exists: () => files().has(MANIFEST_FILE),
    files,
    load,
    stage: () => {
      const dir = mkdtempSync(join(tmpdir(), "adapter-refine-"));
      for (const [rel, content] of files()) {
        const full = join(dir, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
      return dir;
    },
    collect: readTree,
    discard: (dir) => {
      // Only ever a directory this store made, never anything else.
      if (dir.includes("adapter-refine-")) rmSync(dir, { recursive: true, force: true });
    },
    write,
  };
};
