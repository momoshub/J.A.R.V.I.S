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
  // `www.`, `app.` and workspace subdomains all reach the same page.
  if (/^https?:\/\/([a-z0-9-]+\.)?notion\.(so|com|site)\//i.test(t)) return true;
  // A bare 32-character page id, dashed or not.
  return /^[0-9a-f]{32}$/i.test(t.replaceAll("-", "")) && /^[0-9a-f-]+$/i.test(t);
};

/** Slack posts links as `<url|label>`; the page needs the bare url. */
export const unwrap = (token: string): string => {
  const t = token.trim().replace(/^<|>$/g, "");
  const bar = t.indexOf("|");
  return (bar === -1 ? t : t.slice(0, bar)).trim();
};

/**
 * `comment` leaves the page's body alone and adds a comment to it. Asked to
 * comment on a page, the bot had no way to do it at all: every mode wrote the
 * body, so the only honest answer was that it could not.
 */
/**
 * `edit-comment` rewrites a comment already there. Without it, a comment with
 * a typo or the wrong tone could only be fixed by hand or by posting a second
 * one under it, and the bot told people to paste the fix in themselves.
 */
export type NoteMode = "create" | "replace" | "append" | "comment" | "edit-comment";

export type NoteArgs =
  | {
      readonly ok: true;
      readonly path: string;
      readonly mode: NoteMode;
      /** The page being edited; absent when creating. */
      readonly target?: string;
      readonly title?: string;
      /** A comment typed inline rather than written to a file first. */
      readonly text?: string;
    }
  | { readonly ok: false; readonly error: string };

/**
 * `note <file> [title]`
 * `note <file> <notion-url>`            - replace that page's body
 * `note <file> --into <notion-url>`     - the same thing, said out loud
 * `note <file> --append <notion-url>`   - add to the end, change nothing above
 * `note --comment <notion-url> <text>`  - comment on that page, body untouched
 * `note <file> --comment <notion-url>`  - the same, with the comment in a file
 * `note --edit-comment <notion-url> <text>` - rewrite a comment already there
 */
export const parseNoteArgs = (args: readonly string[]): NoteArgs => {
  const lead = (args[0] ?? "").trim();
  if (!lead) return { ok: false, error: "no file" };
  // A comment is usually a line or two, so it may be typed inline instead of
  // written to a file. Only a comment may skip the file.
  const inline = /^--(comment|reply|edit-comment|edit)$/i.test(lead);
  const path = inline ? "" : lead;

  const rest = inline ? args : args.slice(1);
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
    if (flag === "--comment" || flag === "--reply") {
      mode = "comment";
      target = unwrap(rest[++i] ?? "");
      continue;
    }
    if (flag === "--edit-comment" || flag === "--edit") {
      mode = "edit-comment";
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
    if (isNotionUrl(a) && !target) {
      if (mode === "create") mode = "replace";
      target = unwrap(a);
      continue;
    }
    words.push(a);
  }

  if (mode !== "create" && !target) {
    const flag = mode === "replace" ? "into" : mode;
    return { ok: false, error: `\`--${flag}\` needs the page to put it in` };
  }
  if (target && !isNotionUrl(target)) {
    return { ok: false, error: `\`${target}\` is not a Notion page` };
  }
  const joined = words.join(" ").trim();
  if (mode === "comment" || mode === "edit-comment") {
    if (!path && !joined) return { ok: false, error: "an empty comment says nothing" };
    // With a file, the words are noise; without one, they ARE the comment.
    return { ok: true, path, mode, target: target as string, ...(path ? {} : { text: joined }) };
  }
  if (inline) return { ok: false, error: "only a comment can skip the file" };
  return { ok: true, path, mode, ...(target ? { target } : {}), ...(joined ? { title: joined } : {}) };
};
