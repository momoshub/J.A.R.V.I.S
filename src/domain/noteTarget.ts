/**
 * What a `note` is aimed at: a new page, or one that already exists.
 *
 * It only ever created. That was deliberate - it writes under the authorising
 * human's Notion identity, so the first version was scoped to the narrowest
 * safe act - but the result is that asking it to update a document produces a
 * second copy of that document, and now the team has two and neither is
 * obviously the real one. A runbook that silently forks is worse than no
 * runbook.
 *
 * So the target is parsed here, explicitly, and the modes are kept apart:
 * creating is the default, replacing and appending both REQUIRE a page to have
 * been named. Nothing is inferred - the one thing worse than refusing to edit
 * is editing the wrong page.
 */

/** A Notion page url, as pasted, as Slack wraps it, or as a bare page id. */
export const isNotionUrl = (token: string): boolean => {
  const t = unwrap(token);
  if (/^https?:\/\/(www\.)?notion\.(so|com)\//i.test(t)) return true;
  // A bare 32-character page id, dashed or not.
  return /^[0-9a-f]{32}$/i.test(t.replaceAll("-", "")) && /^[0-9a-f-]+$/i.test(t);
};

/** Slack posts links as `<url|label>`; the page needs the bare url. */
export const unwrap = (token: string): string => {
  const t = token.trim().replace(/^<|>$/g, "");
  const bar = t.indexOf("|");
  return (bar === -1 ? t : t.slice(0, bar)).trim();
};

export type NoteMode = "create" | "replace" | "append";

export type NoteArgs =
  | {
      readonly ok: true;
      readonly path: string;
      readonly mode: NoteMode;
      /** The page being edited; absent when creating. */
      readonly target?: string;
      readonly title?: string;
    }
  | { readonly ok: false; readonly error: string };

/**
 * `note <file> [title]`
 * `note <file> <notion-url>`            - replace that page's body
 * `note <file> --into <notion-url>`     - the same thing, said out loud
 * `note <file> --append <notion-url>`   - add to the end, change nothing above
 */
export const parseNoteArgs = (args: readonly string[]): NoteArgs => {
  const path = (args[0] ?? "").trim();
  if (!path) return { ok: false, error: "no file" };

  const rest = args.slice(1);
  let mode: NoteMode = "create";
  let target: string | undefined;
  const words: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const a = (rest[i] ?? "").trim();
    const flag = a.toLowerCase();
    if (flag === "--into" || flag === "--update" || flag === "--replace") {
      mode = "replace";
      target = unwrap(rest[++i] ?? "");
      continue;
    }
    if (flag === "--append" || flag === "--add") {
      mode = "append";
      target = unwrap(rest[++i] ?? "");
      continue;
    }
    // A bare page url is unambiguous - nobody titles a document
    // `notion.so/...` - so it means the obvious thing.
    if (isNotionUrl(a)) {
      if (mode === "create") mode = "replace";
      target = unwrap(a);
      continue;
    }
    words.push(a);
  }

  if (mode !== "create" && !target) {
    return { ok: false, error: `\`--${mode === "append" ? "append" : "into"}\` needs the page to put it in` };
  }
  if (target && !isNotionUrl(target)) {
    return { ok: false, error: `\`${target}\` is not a Notion page` };
  }
  const title = words.join(" ").trim();
  return { ok: true, path, mode, ...(target ? { target } : {}), ...(title ? { title } : {}) };
};
