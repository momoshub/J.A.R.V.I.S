/**
 * Waiting for something to finish, without holding a turn open.
 *
 * A turn cannot wait. It ends, and anything it said it would do "once the
 * build is done" simply never happens - the thread is left with "Image build
 * is still running, waiting on it before promoting" and stops there until a
 * person comes back and nudges it. That is the stall: not an error, not a
 * timeout, just a promise nobody is around to keep.
 *
 * The obvious fix - sleep inside the turn - is the wrong one twice over. It
 * burns the turn's wall clock against `CLAUDE_TIMEOUT_MS`, and the thread
 * queue runs one turn at a time, so a turn asleep for twenty minutes is a
 * thread that cannot be talked to for twenty minutes.
 *
 * So a watch is stored, not held: a shell predicate polled on a timer OUTSIDE
 * any turn, and when it finally succeeds the thread is handed a fresh turn
 * that carries on. Polling costs nothing - no model, no session - and the
 * thread stays live the whole time.
 */

/** How often a watch may poll at the fastest. Anything tighter is a spin. */
export const MIN_EVERY_MS = 15_000;
/** The longest a watch may live. A watch nobody ends is a leak with a timer. */
export const MAX_DEADLINE_MS = 6 * 60 * 60_000;
export const DEFAULT_EVERY_MS = 60_000;
export const DEFAULT_DEADLINE_MS = 45 * 60_000;
/** Consecutive predicate errors before a watch gives up and says so. */
export const MAX_CONSECUTIVE_ERRORS = 10;

export type WatchState = "waiting" | "fired" | "expired" | "cancelled" | "failed";

/** `90s`, `5m`, `2h`. A bare number is minutes, which is what people mean. */
export const parseDuration = (token: string): number | undefined => {
  const t = token.trim().toLowerCase();
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = (m[2] ?? "m")[0];
  return n * (unit === "s" ? 1_000 : unit === "h" ? 3_600_000 : 60_000);
};

/** `4m` from 240000, for reading back. */
export const humanDuration = (ms: number): string => {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.round(ms / 60_000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
};

export type WatchArgs =
  | {
      readonly ok: true;
      /** Shell predicate; exit 0 means ready. Empty means a plain timer. */
      readonly check: string;
      readonly everyMs: number;
      readonly deadlineMs: number;
      /** What to do once it is ready. Becomes the follow-up turn's request. */
      readonly note: string;
    }
  | { readonly ok: false; readonly error: string };

/**
 * `watch [--every 1m] [--until 45m] [-- <shell predicate>] <what to do next>`
 *
 * The predicate is separated by `--` because it is a whole command line, quotes
 * and pipes and all, and anything else would mangle it.
 */
export const parseWatchArgs = (rest: string): WatchArgs => {
  let everyMs = DEFAULT_EVERY_MS;
  let deadlineMs = DEFAULT_DEADLINE_MS;
  let check = "";

  let head = rest.trim();
  // A leading `--` means the predicate was given and the follow-up was not,
  // which is a watch with nothing to do when it comes good.
  if (head.startsWith("--") && !/^--(every|interval|until|for|timeout)\b/i.test(head)) {
    return { ok: false, error: "say what to do once it is ready" };
  }
  const sep = head.indexOf(" -- ");
  if (sep !== -1) {
    check = head.slice(sep + 4).trim();
    head = head.slice(0, sep).trim();
  } else if (head.endsWith(" --")) {
    return { ok: false, error: "nothing to check after `--`" };
  }

  const words = head.length ? head.split(/\s+/) : [];
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = (words[i] ?? "").toLowerCase();
    if (w === "--every" || w === "--interval") {
      const d = parseDuration(words[++i] ?? "");
      if (d === undefined) return { ok: false, error: "`--every` needs a duration like `30s` or `2m`" };
      everyMs = d;
      continue;
    }
    if (w === "--until" || w === "--for" || w === "--timeout") {
      const d = parseDuration(words[++i] ?? "");
      if (d === undefined) return { ok: false, error: "`--until` needs a duration like `45m` or `2h`" };
      deadlineMs = d;
      continue;
    }
    kept.push(words[i] ?? "");
  }

  if (everyMs < MIN_EVERY_MS) {
    return { ok: false, error: `the fastest I will poll is every ${humanDuration(MIN_EVERY_MS)}` };
  }
  if (deadlineMs > MAX_DEADLINE_MS) {
    return { ok: false, error: `a watch can last at most ${humanDuration(MAX_DEADLINE_MS)}` };
  }
  if (everyMs > deadlineMs) {
    return { ok: false, error: "it would check once, after it had already given up" };
  }
  const note = kept.join(" ").trim();
  if (!note) return { ok: false, error: "say what to do once it is ready" };
  return { ok: true, check, everyMs, deadlineMs, note };
};

/** The line the thread gets when a watch comes good. */
export const readyMessage = (note: string, waited: number, output?: string): string => {
  const tail = (output ?? "").trim().split("\n").slice(-3).join("\n").slice(0, 400);
  return [
    `The thing you were waiting for is ready (after ${humanDuration(waited)}). Carry on with exactly this, and do not start it over:`,
    note,
    tail ? `\nWhat the check last printed:\n${tail}` : "",
  ]
    .join("\n")
    .trim();
};

/** The line the thread gets when it never came good. */
export const gaveUpMessage = (note: string, waited: number, why: string): string =>
  `I stopped waiting after ${humanDuration(waited)} - ${why}. What I was waiting to do: ${note}. Say what you want instead; I have not done it.`;
