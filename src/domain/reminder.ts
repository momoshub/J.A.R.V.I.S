/**
 * Reminding people of something later.
 *
 * "nhắc anh lúc 3h chiều", "remind me in 2h to check the deploy" - asked
 * for in plain words, it had nothing to keep the promise with. A watch was
 * the closest thing and it is the wrong one: a watch hands the thread back to
 * the MODEL, it is admin-only because it runs shell, and it lasts six hours at
 * most. A reminder is the opposite on every count - no shell, no turn, no
 * tokens, just a line posted at a time, so anyone may set one and it may sit
 * there for weeks.
 *
 * Times are read in one fixed offset (the host's, injected) rather than per
 * person: the team shares a timezone, and a reminder that silently moved by
 * an hour because somebody's Slack profile was stale is worse than one rule.
 */

/** Reminders closer than this are a typo, not a plan. */
export const MIN_LEAD_MS = 10_000;
/** The furthest ahead a reminder may be set. */
export const MAX_LEAD_MS = 90 * 24 * 3_600_000;
/** People one reminder may tag. More than this is a broadcast. */
export const MAX_TARGETS = 10;
/** Where "tomorrow" lands when no hour was said. */
export const DEFAULT_HOUR = 9;

export type ReminderState = "waiting" | "sent" | "cancelled" | "failed";

/**
 * `90s`, `20m`, `2h`, `3d`, `1h30m`. A bare number is minutes, as with a watch.
 */
export const parseSpan = (token: string): number | undefined => {
  const t = token.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(t)) {
    const n = Number(t);
    return n > 0 ? n * 60_000 : undefined;
  }
  const re = /(\d+(?:\.\d+)?)(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)/g;
  let total = 0;
  let consumed = 0;
  for (const m of t.matchAll(re)) {
    const n = Number(m[1]);
    const u = (m[2] ?? "m")[0];
    total +=
      n *
      (u === "s" ? 1_000 : u === "h" ? 3_600_000 : u === "d" ? 86_400_000 : u === "w" ? 604_800_000 : 60_000);
    consumed += m[0].length;
  }
  return consumed === t.length && total > 0 ? total : undefined;
};

/**
 * A clock time: `15:00`, `9:30`, `3pm`, `3:30pm`, `15h`, `15h30`, `9am`.
 * Returns minutes after midnight.
 */
export const parseClock = (token: string): number | undefined => {
  const t = token.trim().toLowerCase();
  const m =
    t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|sa|ch)$/) ??
    t.match(/^(\d{1,2}):(\d{2})()$/) ??
    t.match(/^(\d{1,2})h(\d{2})?()$/);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const half = m[3];
  if (half) {
    if (h < 1 || h > 12) return undefined;
    if (half === "pm" || half === "ch") h = h === 12 ? 12 : h + 12;
    else if (h === 12) h = 0;
  }
  if (h > 23 || min > 59) return undefined;
  return h * 60 + min;
};

/** Midnight of the local day `now` falls in, as epoch ms. */
const localMidnight = (now: number, offsetMin: number): number => {
  const shifted = now + offsetMin * 60_000;
  return shifted - (shifted % 86_400_000) - offsetMin * 60_000;
};

/** `YYYY-MM-DD` or `DD/MM[/YYYY]`, as local midnight. */
const parseDate = (token: string, now: number, offsetMin: number): number | undefined => {
  const iso = token.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dm = token.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  let y: number;
  let mo: number;
  let d: number;
  if (iso) {
    y = Number(iso[1]);
    mo = Number(iso[2]);
    d = Number(iso[3]);
  } else if (dm) {
    d = Number(dm[1]);
    mo = Number(dm[2]);
    y = dm[3] ? Number(dm[3]) : new Date(now + offsetMin * 60_000).getUTCFullYear();
  } else return undefined;
  const utc = Date.UTC(y, mo - 1, d);
  const check = new Date(utc);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return undefined;
  const at = utc - offsetMin * 60_000;
  // A day and month with no year that has already gone means next year's.
  if (dm && !dm[3] && at + 86_400_000 <= now) return parseDate(`${d}/${mo}/${y + 1}`, now, offsetMin);
  return at;
};

export type ReminderArgs =
  | {
      readonly ok: true;
      /** Who gets tagged. `me` is resolved by the caller to whoever asked. */
      readonly targets: readonly string[];
      readonly dueAt: number;
      readonly text: string;
    }
  | { readonly ok: false; readonly error: string };

const stripTag = (w: string): string | undefined => w.match(/^<@([A-Z0-9]+)(?:\|[^>]*)?>$/)?.[1];

/**
 * `remind [me|<@someone>...] (in <span> | <span> | at <time> [today|tomorrow] |
 * tomorrow [at <time>] | on <date> [at <time>]) [to] <what>`
 *
 * The who, then the when, then the what, because that is the order people say
 * it in. Everything after the when is the text, verbatim.
 */
export const parseRemindArgs = (rest: string, actorId: string, now: number, offsetMin: number): ReminderArgs => {
  const words = rest.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  const targets: string[] = [];
  for (; i < words.length; i++) {
    const w = words[i] ?? "";
    if (w.toLowerCase() === "me" && i === 0) {
      targets.push(actorId);
      continue;
    }
    const id = stripTag(w);
    if (!id) break;
    if (!targets.includes(id)) targets.push(id);
  }
  if (targets.length === 0) targets.push(actorId);
  if (targets.length > MAX_TARGETS) return { ok: false, error: `I will tag at most ${MAX_TARGETS} people at once` };

  const word = (k: number): string => (words[k] ?? "").toLowerCase();
  let dueAt: number | undefined;
  let day: number | undefined;
  let clock: number | undefined;

  if (word(i) === "in" && parseSpan(word(i + 1)) !== undefined) {
    dueAt = now + (parseSpan(word(i + 1)) ?? 0);
    i += 2;
  } else if (parseSpan(word(i)) !== undefined && words.length > i + 1 && !/^\d+$/.test(word(i))) {
    // `remind 20m check it`. A bare number is not taken as a span here: in
    // "remind 3 people" it is a word.
    dueAt = now + (parseSpan(word(i)) ?? 0);
    i += 1;
  } else {
    // Any order of `at <time>`, `today`, `tomorrow`, `on <date>`, `<date>`.
    for (;;) {
      const w = word(i);
      if ((w === "at" || w === "lúc") && parseClock(word(i + 1)) !== undefined && clock === undefined) {
        clock = parseClock(word(i + 1));
        i += 2;
      } else if (parseClock(w) !== undefined && clock === undefined && /:|am$|pm$/.test(w)) {
        // Bare only when it cannot be a span: `15:00` and `3pm`, never `15h`,
        // which `remind 2h ...` has already taken to mean two hours.
        clock = parseClock(w);
        i += 1;
      } else if ((w === "today" || w === "tonight") && day === undefined) {
        day = localMidnight(now, offsetMin);
        i += 1;
      } else if (w === "tomorrow" && day === undefined) {
        day = localMidnight(now, offsetMin) + 86_400_000;
        i += 1;
      } else if (w === "on" && parseDate(word(i + 1), now, offsetMin) !== undefined && day === undefined) {
        day = parseDate(word(i + 1), now, offsetMin);
        i += 2;
      } else if (parseDate(w, now, offsetMin) !== undefined && day === undefined) {
        day = parseDate(w, now, offsetMin);
        i += 1;
      } else break;
    }
    if (clock !== undefined || day !== undefined) {
      const minutes = clock ?? DEFAULT_HOUR * 60;
      if (day !== undefined) dueAt = day + minutes * 60_000;
      else {
        // A bare time that has already passed today means tomorrow's.
        const today = localMidnight(now, offsetMin) + minutes * 60_000;
        dueAt = today > now ? today : today + 86_400_000;
      }
    }
  }

  if (dueAt === undefined) return { ok: false, error: "say when - `in 2h`, `at 15:00`, `tomorrow 9am` or `on 2026-12-01`" };
  if (/^(to|that|about|-|:|rằng|là)$/i.test(word(i))) i += 1;
  const text = words.slice(i).join(" ").trim();
  if (!text) return { ok: false, error: "say what to remind about" };
  if (dueAt - now < MIN_LEAD_MS) return { ok: false, error: "that time has already gone" };
  if (dueAt - now > MAX_LEAD_MS) return { ok: false, error: "I keep reminders for 90 days at most" };
  return { ok: true, targets, dueAt: Math.round(dueAt), text };
};

const pad = (n: number): string => String(n).padStart(2, "0");
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `Thu 05/11 15:00` in the given offset. */
export const formatWhen = (at: number, offsetMin: number): string => {
  const d = new Date(at + offsetMin * 60_000);
  return `${WEEKDAYS[d.getUTCDay()]} ${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

/** `in 2h05m`, `in 3d`, for reading a due time back. */
export const humanLead = (ms: number): string => {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 1) return "in under a minute";
  if (mins < 60) return `in ${mins}m`;
  if (mins < 48 * 60) return `in ${Math.floor(mins / 60)}h${mins % 60 ? pad(mins % 60) + "m" : ""}`;
  return `in ${Math.round(mins / 1440)}d`;
};

/** The line posted when one comes due. */
export const reminderMessage = (targets: readonly string[], text: string, setBy: string): string => {
  const tags = targets.map((t) => `<@${t}>`).join(" ");
  const from = targets.length === 1 && targets[0] === setBy ? "" : ` (from <@${setBy}>)`;
  return `⏰ ${tags} reminder: ${text}${from}`;
};
