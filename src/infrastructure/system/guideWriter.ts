/**
 * Writes the how-to guides a turn's prompt points at (see
 * `domain/promptGuides.ts`). A file is named by its content, so one that
 * exists is already right: it is written once, then only checked for. Written
 * to a temp name and renamed, so a turn reading it never sees half a file.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { guideFile, type PromptGuide } from "../../domain/promptGuides.ts";

export const writeGuides = (dir: string, guides: readonly PromptGuide[]): void => {
  if (guides.length === 0) return;
  mkdirSync(dir, { recursive: true });
  for (const guide of guides) {
    const path = join(dir, guideFile(guide));
    if (existsSync(path)) continue;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${guide.body}\n`);
    renameSync(tmp, path);
  }
};
