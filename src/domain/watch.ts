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

/**
 * The things it actually ends up waiting for.
 *
 * Every one of these was reachable before with a hand-written `-- <shell>`,
 * and that is exactly the problem: the turn had to invent a predicate under
 * pressure, at the moment it was already trying to wind down. A named kind is
 * one word, and it is the same command every time, so it either works for
 * everyone or is broken for everyone rather than being a coin toss per turn.
 *
 * `pr` and `checks` cover the work it CREATED - the PR it opened, the CI it
 * triggered. `reply` covers the answer it is owed by somebody else, whether
 * that is a person, another agent, or a build bot posting back. `url` covers
 * a deployment, once there is something to curl.
 */
export type BuiltinKind = "pr" | "checks" | "reply" | "url";

export const BUILTIN_KINDS: readonly BuiltinKind[] = ["pr", "checks", "reply", "url"];

export const asBuiltinKind = (word: string): BuiltinKind | undefined => {
  const w = word.toLowerCase();
  if (w === "pr" || w === "merged") return "pr";
  if (w === "checks" || w === "ci" || w === "build") return "checks";
  if (w === "reply" || w === "answer" || w === "thread") return "reply";
  if (w === "url" || w === "http" || w === "deploy") return "url";
  return undefined;
};

export type BuiltinOptions = {
  /** `reply` only: where to look, and from when. */
  readonly channel?: string;
  readonly threadTs?: string;
  readonly afterTs?: string;
  /** `reply` only: wait for this person (or bot) specifically. */
  readonly from?: string;
  /** Absolute path of the Slack wait helper, for `reply`. */
  readonly slackWaitScript?: string;
};

/** Single-quote for `sh -c`, so a url with an `&` cannot become two commands. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The shell predicate behind a named kind. Exit 0 means ready.
 *
 * `gh pr checks` exit codes are measured, not guessed: 0 when every check
 * passed, 8 while any is still running, 1 when one failed. Waiting for CI
 * means waiting for it to STOP being 8 - a failed build is an answer, and a
 * watch that only fired on success would sit there until its deadline on the
 * exact day somebody most needs to hear about it.
 */
export const builtinCheck = (
  kind: BuiltinKind,
  target: string,
  opts: BuiltinOptions = {},
): { readonly check: string } | { readonly error: string } => {
  if (kind === "pr") {
    if (!/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.test(target)) {
      return { error: "`watch pr` needs a GitHub pull request url" };
    }
    return { check: `gh pr view ${shellQuote(target)} --json state -q .state | grep -qx MERGED` };
  }
  if (kind === "checks") {
    if (!/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.test(target)) {
      return { error: "`watch checks` needs a GitHub pull request url" };
    }
    return {
      check: `gh pr checks ${shellQuote(target)} >/dev/null 2>&1; [ $? -ne 8 ]`,
    };
  }
  if (kind === "url") {
    if (!/^https?:\/\//i.test(target)) return { error: "`watch url` needs an http url" };
    return { check: `curl -sfS --max-time 20 -o /dev/null ${shellQuote(target)}` };
  }
  // reply
  if (!opts.slackWaitScript) return { error: "I have no way to watch a Slack thread here" };
  if (!opts.channel || !opts.threadTs) return { error: "`watch reply` needs a link to the thread" };
  const args = [opts.channel, opts.threadTs, opts.afterTs ?? "0"];
  if (opts.from) args.push(opts.from);
  return { check: `${opts.slackWaitScript} ${args.map(shellQuote).join(" ")}` };
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
      /** A named wait, when one was asked for instead of a raw predicate. */
      readonly kind?: BuiltinKind;
      readonly target?: string;
      /** `reply` only: the person or bot whose answer is being waited for. */
      readonly from?: string;
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
  let kind: BuiltinKind | undefined;
  let target: string | undefined;
  let from: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const w = (words[i] ?? "").toLowerCase();
    // A named wait is the FIRST word, and takes the next one as its target.
    // Anywhere else it is just a word in the note - "watch the pr" should not
    // quietly become a pull request watch.
    if (kept.length === 0 && kind === undefined && asBuiltinKind(w) && words[i + 1]) {
      kind = asBuiltinKind(w);
      target = (words[++i] ?? "").replace(/^<|>$/g, "").split("|")[0];
      continue;
    }
    if (kind === "reply" && w === "from" && words[i + 1]) {
      from = (words[++i] ?? "").replace(/^<@|>$/g, "").split("|")[0];
      continue;
    }
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
  return {
    ok: true,
    check,
    everyMs,
    deadlineMs,
    note,
    ...(kind ? { kind } : {}),
    ...(target ? { target } : {}),
    ...(from ? { from } : {}),
  };
};

/**
 * The line the thread gets when a watch comes good.
 *
 * It has to say DO IT, in those words. The turn that set the watch was already
 * trying to hand the work back - "anh promote giúp em", "tell me the right
 * command and I'll run it" - and a hand-back after a forty minute wait is
 * worse than one before it, because the person has stopped watching the thread
 * by then. The escape hatch is kept deliberately narrow: name the obstacle, do
 * not ask for permission you were already given.
 */
export const readyMessage = (note: string, waited: number, output?: string): string => {
  const tail = (output ?? "").trim().split("\n").slice(-3).join("\n").slice(0, 400);
  return [
    `The thing you were waiting for is ready (after ${humanDuration(waited)}). Carry on with exactly this, and do not start it over:`,
    note,
    "",
    "Do it yourself, now, with the commands and tools you already have. This was agreed before the wait - you are finishing a job, not proposing one, so do not ask whether to go ahead and do not hand the steps back for someone else to type. If something genuinely stops you, say in one line what you tried and what blocked it.",
    tail ? `\nWhat the check last printed:\n${tail}` : "",
  ]
    .join("\n")
    .trim();
};

/** The line the thread gets when it never came good. */
export const gaveUpMessage = (note: string, waited: number, why: string): string =>
  `I stopped waiting after ${humanDuration(waited)} - ${why}. What I was waiting to do: ${note}. Say what you want instead; I have not done it.`;
