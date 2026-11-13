/**
 * A recurring prompt: "every monday 9am, search the web for new slang and
 * update my slang learning".
 *
 * `remind` posts a fixed line and runs nothing; `watch` hands a thread back to
 * the model once and is done. A loop is the missing third thing - the thread
 * gets a real turn, on a schedule, with nobody there. That spends tokens with
 * no human watching, which is why it is admin-only and why the shortest
 * interval is an hour.
 *
 * Times are read in the host's offset, injected, exactly like `remind`.
 */
import { unescapeSlack } from "./cloudwatch.ts";
import { localMidnight, parseClock, parseSpan } from "./reminder.ts";

/** Anything faster is a runaway, not a schedule. */
export const MIN_INTERVAL_MS = 3_600_000;
/** A script spends no tokens, so it may run much more often. */
export const MIN_SCRIPT_INTERVAL_MS = 300_000;
/** Where "every monday" lands when no hour was said. */
export const DEFAULT_LOOP_MINUTES = 9 * 60;
/** Active loops one person may own. */
export const MAX_LOOPS_PER_USER = 10;
export const MAX_PROMPT_CHARS = 2000;
/** A name is a label in a DM header, not a description. */
export const MAX_NAME_CHARS = 40;
/** How many words of the prompt a derived name keeps. */
const DERIVED_NAME_WORDS = 4;

/**
 * Slack hands text over as mrkdwn: links as `<url|label>` / `<url>`, mentions
 * as `<@U1|kai>` / `<#C1|name>` / `<!channel>`, and `&`, `<`, `>` escaped. Read
 * it as the words a person sees: a link is its label, a mention its name, then
 * the entities are undone. Links go first, since an escaped `&lt;` is text.
 */
const plainSlack = (text: string): string =>
  unescapeSlack(
    text
      .replace(/<([^<>|]*)\|([^<>]*)>/g, "$2")
      .replace(/<([^<>]*)>/g, (_m, inner: string) => inner.replace(/^[@#!]/, "")),
  );

/**
 * A name that is safe to put in a Slack message: no mrkdwn markers, no
 * `<...>` link / mention syntax, no `&` entities, one line, clipped. What is
 * left is plain words, so a name can never become a link, a mention or bold.
 */
export const cleanName = (raw: string): string =>
  plainSlack(raw)
    .replace(/[<>&*_~`|\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_CHARS)
    .trim();

/** The first few words of what the loop does, as a name, for a loop nobody named. */
export const deriveName = (prompt: string, command: string = ""): string => {
  // Read the markup first: a link's label has spaces, so splitting on words would cut it in half.
  const words = plainSlack(prompt.trim() || command.trim()).split(/\s+/).filter(Boolean);
  return cleanName(words.slice(0, DERIVED_NAME_WORDS).join(" ")) || (command ? "script" : "loop");
};

/** How a loop is referred to in every message: `PR board - loop #3`. */
export const loopRef = (id: number, name: string, noun: string = "loop"): string =>
  name ? `${name} - ${noun} #${id}` : `${noun} #${id}`;

/** `pending`: a script loop a turn wrote, waiting for the owner's Approve. It never runs. */
export type LoopState = "pending" | "active" | "cancelled" | "failed";

/** How long an unanswered script loop waits before it is deleted. */
export const PENDING_TTL_MS = 86_400_000;

/** Button ids. `jv:` like every element of ours, but decided in code, never handed to the model. */
export const LOOP_ACTION_PREFIX = "jv:loop:";
export const LOOP_APPROVE_ACTION = `${LOOP_ACTION_PREFIX}approve`;
export const LOOP_REJECT_ACTION = `${LOOP_ACTION_PREFIX}reject`;

/** Slack reads `<url|label>`, `<!channel>`, `<@U…>` and `&…;` even inside a code fence, so the shell is shown escaped. */
export const escapeForSlack = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The lines of the approval DM that say what runs: a press counts only while the pressed message still shows them. */
export const approvalCore = (schedule: string, command: string): readonly [string, string] => [
  `schedule: ${schedule}`,
  `\`\`\`${escapeForSlack(command.replaceAll("```", "'''"))}\`\`\``,
];

/** The approval DM: the exact shell and schedule, so what is approved is what runs. */
export const approvalText = (
  id: number,
  schedule: string,
  command: string,
  ttlMs: number = PENDING_TTL_MS,
  name: string = "",
): string =>
  [
    `🔐 I wrote a script loop (#${id}) and it needs your OK before it ever runs.`,
    approvalCore(schedule, command)[0],
    "command (runs as me, with no turn):",
    approvalCore(schedule, command)[1],
    ...(name ? [`name (chosen by the turn, not checked): ${name}`] : []),
    `Approve starts it, Reject deletes it. No answer in ${Math.round(ttlMs / 3_600_000)}h also deletes it.`,
  ].join("\n");

export const settledLoopText = (
  kind: "approved" | "rejected" | "expired",
  id: number,
  by?: string,
  name: string = "",
): string => {
  const ref = loopRef(id, name, "script loop");
  return kind === "approved"
    ? `✅ ${ref} approved${by ? ` by <@${by}>` : ""} - it runs on its schedule now`
    : kind === "rejected"
      ? `❌ ${ref} rejected${by ? ` by <@${by}>` : ""} - deleted`
      : `⌛ ${ref} expired with no answer - deleted`;
};

export type Schedule =
  | { readonly kind: "interval"; readonly everyMs: number }
  | { readonly kind: "daily"; readonly minutes: number }
  | { readonly kind: "weekly"; readonly weekday: number; readonly minutes: number };

const DAY_MS = 86_400_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** `mon`, `mondays`, `Monday` -> 1. */
const weekdayOf = (word: string): number | undefined => {
  const w = word.toLowerCase().replace(/s$/, "");
  if (w.length < 3) return undefined;
  const i = WEEKDAYS.findIndex((d) => d === w || (w.length <= 4 && d.startsWith(w)));
  return i >= 0 ? i : undefined;
};

const pad = (n: number): string => String(n).padStart(2, "0");
const clockText = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** The one spelling a stored schedule is kept in; `parseSchedule` reads it back. */
export const scheduleText = (s: Schedule): string => {
  if (s.kind === "daily") return `every day at ${clockText(s.minutes)}`;
  if (s.kind === "weekly") return `every ${WEEKDAYS[s.weekday]} at ${clockText(s.minutes)}`;
  const mins = Math.round(s.everyMs / 60_000);
  if (mins % 1440 === 0) return `every ${mins / 1440}d`;
  if (mins % 60 === 0) return `every ${mins / 60}h`;
  return `every ${mins}m`;
};

export type ParsedLoop =
  | {
      readonly ok: true;
      readonly schedule: Schedule;
      /** Given with `--name`, else the first words of the prompt (or command). Slack-safe. */
      readonly name: string;
      /** Prompt mode: what the turn is asked. Empty in script mode. */
      readonly prompt: string;
      /** Script mode: the shell command, run with no turn. Empty in prompt mode. */
      readonly command: string;
    }
  | { readonly ok: false; readonly error: string };

const USAGE = "say how often - `every monday 9am`, `every day at 18:00`, `every 6h` or `every week`";

/** The schedule prefix of `words` and how many words it used, or nothing. */
const readSchedule = (words: readonly string[]): { schedule: Schedule; used: number } | undefined => {
  const word = (i: number): string => (words[i] ?? "").toLowerCase();
  if (word(0) !== "every") return undefined;
  let i = 2;
  const head = word(1);

  // `at 18:00` or `18:00`, only when what follows really is a clock time.
  const clockAfter = (): number | undefined => {
    const at = word(i) === "at" ? i + 1 : i;
    const c = parseClock(word(at));
    if (c === undefined) return undefined;
    i = at + 1;
    return c;
  };

  const day = weekdayOf(head);
  let schedule: Schedule | undefined;
  if (head === "day" || head === "daily") {
    const c = clockAfter();
    schedule = c === undefined ? { kind: "interval", everyMs: DAY_MS } : { kind: "daily", minutes: c };
  } else if (head === "week" || head === "weekly") {
    schedule = { kind: "interval", everyMs: 7 * DAY_MS };
  } else if (day !== undefined) {
    schedule = { kind: "weekly", weekday: day, minutes: clockAfter() ?? DEFAULT_LOOP_MINUTES };
  } else if (!/^\d+(?:\.\d+)?$/.test(head)) {
    // A bare number is not a span here: "every 6 things" is not six minutes.
    const ms = parseSpan(head);
    if (ms !== undefined) schedule = { kind: "interval", everyMs: ms };
  }
  return schedule ? { schedule, used: i } : undefined;
};

/**
 * Slack hands a command over as mrkdwn: `&`, `<`, `>` escaped and links wrapped
 * as `<url>` / `<url|label>`. Unwrap the links first (their brackets are real),
 * then unescape, so the stored shell is what was typed.
 */
export const unslackShell = (text: string): string =>
  unescapeSlack(text.replace(/<((?:https?|mailto):[^|>\s]+)(?:\|[^>]*)?>/g, "$1"));

const NAME_FLAG = /^--name(?:=|\s+|$)/;

/** What follows the schedule: an optional `--name <word | "words">`, then the rest. `undefined` when there is no flag. */
const readName = (tail: string): { name: string; rest: string } | { error: string } | undefined => {
  if (!NAME_FLAG.test(tail)) return undefined;
  const value = tail.replace(NAME_FLAG, "");
  const quoted = /^(["“'‘])/.exec(value);
  if (quoted) {
    const close = { '"': '"', "“": "”", "'": "'", "‘": "’" }[quoted[1] as string] as string;
    // A closing quote ends a word: the apostrophe in `'Kai's board'` is part of the name.
    let end = value.indexOf(close, 1);
    while (end >= 0 && end + 1 < value.length && !/\s/.test(value[end + 1] ?? "")) end = value.indexOf(close, end + 1);
    if (end < 0) return { error: "close the quote after `--name`" };
    return { name: cleanName(value.slice(1, end)), rest: value.slice(end + 1).trim() };
  }
  const word = /^\S+/.exec(value)?.[0];
  if (!word) return { error: "say a name after `--name`, e.g. `--name \"PR board\"`" };
  return { name: cleanName(word), rest: value.slice(word.length).trim() };
};

/**
 * `every monday 9am <prompt>`, `every day at 18:00 <prompt>`, `every 6h <prompt>`,
 * `every week <prompt>`; or, for a script, `every 15m -- <shell command>`. The
 * schedule is the shortest prefix that reads as one; everything after it is
 * the prompt (or command), verbatim. A name may sit between the two:
 * `every 6h --name "PR board" <prompt>`; without one it is derived.
 */
export const parseLoopArgs = (rest: string): ParsedLoop => {
  const words = rest.trim().split(/\s+/).filter(Boolean);
  const read = readSchedule(words);
  if (!read) return { ok: false, error: USAGE };
  const { schedule, used } = read;
  // The text after the schedule words, spacing and quoting intact.
  let tail = rest.trim();
  for (let i = 0; i < used; i++) tail = tail.replace(/^\S+\s*/, "");
  const named = readName(tail);
  if (named && "error" in named) return { ok: false, error: named.error };
  const body = named ? named.rest : tail;
  const script = /^--(\s|$)/.test(body);
  const min = script ? MIN_SCRIPT_INTERVAL_MS : MIN_INTERVAL_MS;
  if (schedule.kind === "interval" && schedule.everyMs < min) {
    return { ok: false, error: `the shortest ${script ? "script " : ""}loop is every ${script ? "5m" : "1h"}` };
  }
  if (script) {
    const command = unslackShell(body.replace(/^--/, "").trim());
    if (!command) return { ok: false, error: "say which command to run each time" };
    if (command.length > MAX_PROMPT_CHARS) {
      return { ok: false, error: `keep the command under ${MAX_PROMPT_CHARS} characters` };
    }
    return { ok: true, schedule, name: named?.name || deriveName("", command), prompt: "", command };
  }
  const prompt = body.split(/\s+/).filter(Boolean).join(" ");
  if (!prompt) return { ok: false, error: "say what to do each time" };
  if (prompt.length > MAX_PROMPT_CHARS) {
    return { ok: false, error: `keep the prompt under ${MAX_PROMPT_CHARS} characters` };
  }
  return { ok: true, schedule, name: named?.name || deriveName(prompt), prompt, command: "" };
};

/** Reads a stored schedule back; `undefined` for anything this did not write. */
export const parseSchedule = (text: string): Schedule | undefined =>
  readSchedule(text.trim().split(/\s+/).filter(Boolean))?.schedule;

/**
 * The first fire strictly after `after`. A loop is always rescheduled from NOW,
 * never from the slot it missed, so a bot that was down for three days owes one
 * run, not seventy-two.
 */
export const nextRun = (s: Schedule, after: number, offsetMin: number): number => {
  if (s.kind === "interval") return after + s.everyMs;
  const midnight = localMidnight(after, offsetMin);
  if (s.kind === "daily") {
    const today = midnight + s.minutes * 60_000;
    return today > after ? today : today + DAY_MS;
  }
  const dow = new Date(midnight + offsetMin * 60_000).getUTCDay();
  const ahead = (s.weekday - dow + 7) % 7;
  const at = midnight + ahead * DAY_MS + s.minutes * 60_000;
  return at > after ? at : at + 7 * DAY_MS;
};

/** What the turn is told: it is scheduled, nobody is waiting, keep it short. */
export const loopTurnText = (id: number, schedule: string, prompt: string, name: string = ""): string =>
  `[loop ${id}] Scheduled run${name ? ` of "${name}"` : ""} (${schedule}) - nobody is watching live. Do the task below and keep your reply short: what you did and anything that needs a person, nothing else.\n\n${prompt}`;
