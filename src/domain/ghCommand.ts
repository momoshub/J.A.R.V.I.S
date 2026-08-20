/**
 * Reading a `gh` shell command back.
 *
 * The review command watches the brain's tool calls so it can relay each PR
 * action to Slack as it lands. Relaying the body too means recovering it from
 * the command that ran, which in practice takes one of two shapes:
 *
 *   gh pr comment <url> --body "…"
 *   cat > /tmp/r.md <<'EOF'
 *   …
 *   EOF
 *   gh pr review <url> --request-changes --body-file /tmp/r.md
 *
 * The heredoc form is what the CLI reaches for on anything longer than a line,
 * so the body is usually right there in the same command. Anything unrecognised
 * returns undefined - the caller falls back to announcing the action alone.
 */

export type GhAction = "comment" | "request-changes";

const ACTION_LINE: Record<GhAction, RegExp> = {
  comment: /gh\s+pr\s+comment[^\n]*/i,
  "request-changes": /gh\s+pr\s+review[^\n]*--request-changes[^\n]*/i,
};

/** Unescape a double-quoted shell string (single quotes are already literal). */
const unescapeDouble = (s: string): string => s.replace(/\\(["`$\\\n])/g, "$1");

const BODY_INLINE = /--body(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/;
const BODY_FILE = /--body-file(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Body of the heredoc that wrote `path` earlier in the same command, if any. */
const heredocFor = (command: string, path: string): string | undefined => {
  const target = escapeRe(path);
  // cat > path <<'EOF' … EOF   (also >>, tee, and unquoted/"quoted" delimiters)
  const re = new RegExp(
    `(?:cat|tee)\\s+(?:>>?\\s*)?["']?${target}["']?[^\\n]*<<-?\\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\\1[^\\n]*\\n([\\s\\S]*?)\\n\\s*\\2\\s*(?:\\n|$)`,
  );
  return command.match(re)?.[3];
};

/**
 * The body a `gh pr comment` / `gh pr review --request-changes` posted, as text.
 * Returns undefined when the command does not carry that action, or when the
 * body lives somewhere this cannot see (a file written by an earlier command).
 */
export const postedBody = (command: string, action: GhAction): string | undefined => {
  const line = command.match(ACTION_LINE[action])?.[0];
  if (!line) return undefined;

  const inline = line.match(BODY_INLINE);
  if (inline) {
    const [, dq, sq, bare] = inline;
    const body = dq !== undefined ? unescapeDouble(dq) : (sq ?? bare ?? "");
    return body.trim() || undefined;
  }

  const file = line.match(BODY_FILE);
  const path = file?.[1] ?? file?.[2] ?? file?.[3];
  if (!path) return undefined;
  return heredocFor(command, path)?.trim() || undefined;
};
