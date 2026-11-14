/**
 * Journeys: the bot's own record of work it did, is doing, or will do.
 *
 * Slack was the only memory of "what happened with that PR last week", and
 * digging through threads is the slow way to answer it. A journey is one row
 * per piece of real work (a PR, an investigation, a worker) with a status, a
 * progress number, what is happening now and what comes next, plus an
 * append-only event trail so "what did you do last week" is a query.
 *
 * Nothing here is clever: this file parses the typed line and words the
 * answer; the repo keeps the rows.
 */
import { plainSlack } from "./loop.ts";
import { parseSpan } from "./reminder.ts";
import { humanDuration } from "./watch.ts";

export const JOURNEY_STATUSES = ["planned", "doing", "blocked", "done", "dropped"] as const;
export type JourneyStatus = (typeof JOURNEY_STATUSES)[number];

/** Still to do or under way: what `list` shows when no status is named. */
export const OPEN_STATUSES: readonly JourneyStatus[] = ["planned", "doing", "blocked"];

export const EVENT_KINDS = ["created", "status", "progress", "note", "pr"] as const;
export type JourneyEventKind = (typeof EVENT_KINDS)[number];

export const MAX_TITLE = 120;
export const MAX_AREA = 40;
export const MAX_LINE = 300;
export const MAX_NOTE = 500;
export const MAX_PRS = 10;

const STATUS_EMOJI: Record<JourneyStatus, string> = {
  planned: "🗓️",
  doing: "🔧",
  blocked: "⛔",
  done: "✅",
  dropped: "🗑️",
};

export const isStatus = (v: string): v is JourneyStatus => (JOURNEY_STATUSES as readonly string[]).includes(v);

/**
 * One line of plain text. The text is typed by a person or written by a turn
 * that may have read something hostile, and `list` / `show` post it back, so
 * it must never become a mention, a link or a broadcast: `<!channel>`,
 * `<@U1>` and `<url|label>` are read first (what is left is the words), then
 * the markers that make bold, strike, code and links are dropped, like a
 * loop's name. Underscores stay, for `snake_case` names.
 */
export const cleanLine = (text: string, max: number): string =>
  plainSlack(text)
    .replace(/[<>&*~`|\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();

/** A GitHub pull request url, the only link a journey keeps as a PR. */
export const PR_URL_RE = /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

/** `<url|label>` and `<url>` are how Slack hands a link over. */
export const unwrapLink = (token: string): string => token.replace(/^<|>$/g, "").split("|")[0] ?? "";

/**
 * Split a line into words, keeping "quoted phrases" together. Smart quotes
 * count, because Slack's client turns straight ones into them.
 */
export const tokenize = (line: string): string[] => {
  const out: string[] = [];
  // A quote closes only at the end of a word, so `'it's broken'` is one value.
  const re = /(--[\w-]+=)?(?:["“”](.*?)["“”](?=\s|$)|['‘’](.*?)['‘’](?=\s|$)|(\S+))/g;
  for (const m of line.matchAll(re)) out.push((m[1] ?? "") + (m[2] ?? m[3] ?? m[4] ?? ""));
  return out;
};

/** What a `journey add|update` line carries: every flag, and the words left over. */
export type JourneyFlags = {
  readonly words: readonly string[];
  readonly status?: string;
  readonly progress?: string;
  readonly now?: string;
  readonly next?: string;
  readonly area?: string;
  readonly note?: string;
  readonly title?: string;
  readonly since?: string;
  readonly prs: readonly string[];
  /** A flag that needs a value and has none, or one that is not a flag of ours. */
  readonly error?: string;
};

const VALUE_FLAGS = ["status", "progress", "now", "next", "area", "note", "title", "since", "pr"] as const;
/** Free text a person may blank out (`--now ""`); the rest need a value. */
const CLEARABLE = ["now", "next", "area", "note"];

export const parseFlags = (tokens: readonly string[]): JourneyFlags => {
  const words: string[] = [];
  const found: Record<string, string> = {};
  const prs: string[] = [];
  let error: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? "";
    if (!t.startsWith("--") || t === "--") {
      words.push(t);
      continue;
    }
    const eq = t.indexOf("=");
    const name = (eq === -1 ? t.slice(2) : t.slice(2, eq)).toLowerCase();
    if (!(VALUE_FLAGS as readonly string[]).includes(name)) {
      error ??= `I do not know \`--${name}\``;
      continue;
    }
    const value = eq === -1 ? tokens[++i] : t.slice(eq + 1);
    if (value === undefined || (value === "" && !CLEARABLE.includes(name))) {
      error ??= `\`--${name}\` needs a value`;
      continue;
    }
    if (name === "pr") prs.push(unwrapLink(value));
    else found[name] = value;
  }
  return { words, ...found, prs, ...(error ? { error } : {}) };
};

/** `40`, `40%`: a whole number 0-100. */
export const parseProgress = (v: string): number | undefined => {
  const m = v.trim().match(/^(\d{1,3})%?$/);
  const n = m ? Number(m[1]) : NaN;
  return n >= 0 && n <= 100 ? n : undefined;
};

/** `7d`, `12h`, `2w` back from now, as the epoch ms a `--since` filter starts at. */
export const sinceCutoff = (v: string, now: number): number | undefined => {
  const span = parseSpan(v);
  return span === undefined ? undefined : now - span;
};

/** `#12` or `12`. */
export const parseId = (v: string | undefined): number | undefined => {
  const n = Number((v ?? "").replace(/^#/, ""));
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export const statusEmoji = (s: JourneyStatus): string => STATUS_EMOJI[s];

export const ago = (at: number, now: number): string => (now - at < 60_000 ? "just now" : `${humanDuration(now - at)} ago`);

/** The one-line form `list` uses. */
export const journeyLine = (
  j: { id: number; title: string; status: JourneyStatus; area: string; progress: number; now: string; updatedAt: number },
  now: number,
): string => {
  const bits = [
    `- #${j.id} ${STATUS_EMOJI[j.status]} *${j.title}*`,
    j.area ? `[${j.area}]` : "",
    j.status === "doing" || j.status === "blocked" ? `${j.progress}%` : "",
    j.now && (j.status === "doing" || j.status === "blocked") ? `- ${j.now}` : "",
    `_${ago(j.updatedAt, now)}_`,
  ];
  return bits.filter(Boolean).join(" ");
};

export const helpText = (prefix: string): string =>
  [
    "*journey* - my own record of work I did, am doing, or will do (in my DB, so it outlives any thread)",
    `- \`${prefix} journey add <title> [--area X] [--status planned|doing|blocked] [--now "..."] [--next "..."] [--pr <url>]\``,
    `- \`${prefix} journey update <id> [--status S] [--progress 0-100] [--now "..."] [--next "..."] [--pr <url>] [--note "..."] [--area X] [--title "..."]\``,
    `- \`${prefix} journey done <id> [note]\` / \`${prefix} journey drop <id> [reason]\``,
    `- \`${prefix} journey list [planned|doing|blocked|done|dropped|open|all] [--since 7d] [--area X]\` (open ones by default)`,
    `- \`${prefix} journey show <id>\` - the fields and the event trail`,
    '_`--now ""` (also `--next`, `--area`) clears a field._',
    "_Anyone may list and show; add, update, done and drop need the journeys:write permission (admin and owner by default). Run in a thread, `add` links that thread._",
  ].join("\n");
