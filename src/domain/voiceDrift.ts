/**
 * Voice drift: a final reply that broke the persona's mechanical voice rules.
 *
 * The owner reads a reply that breaks those rules as a canary - a turn that
 * lost its style rules has usually lost others, so the content may be wrong
 * too. The inner child does not file drift as a defect to fix in code and
 * never touches the drifted message (the visible slip is the point). It asks
 * the session that wrote it to re-check that reply and correct anything that
 * is actually wrong, in a new reply.
 *
 * Everything here is pure: the cheap deterministic check (capital paragraph
 * starts, forbidden characters, headings, bold), the nudge, and the log lines.
 * Only a language mismatch needs a model; it rides on the triage run.
 */

export type DriftRule = "capital" | "dash" | "semicolon" | "arrow" | "heading" | "bold" | "language";

export type DriftHit = {
  readonly rule: DriftRule;
  /** The offending line's start, as it reads in the reply. */
  readonly excerpt: string;
};

/** What each rule is called when the session and the owner are told about it. */
export const RULE_LABEL: Readonly<Record<DriftRule, string>> = {
  capital: "a paragraph starts with a capital letter",
  dash: "an em/en dash",
  semicolon: "a semicolon",
  arrow: "an arrow character",
  heading: "a markdown heading",
  bold: "**double asterisk** bold",
  language: "a different language from the thread",
};

const EXCERPT_CHARS = 80;

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}...` : t;
};

/**
 * The reply with everything that is not the bot's own prose taken out: code
 * blocks and inline code (a semicolon in code is code), Slack links, mentions
 * and channel refs, bare URLs, and HTML entities (`&amp;` ends in `;`).
 * Line structure is kept so paragraph starts stay where they were.
 */
export const proseOf = (reply: string): string =>
  reply
    .replace(/```[\s\S]*?(?:```|$)/g, (m) => "\n".repeat((m.match(/\n/g) ?? []).length))
    .replace(/`[^`\n]*`/g, " ")
    .replace(/<[^>\n]*>/g, " ")
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/\bhttps?:\/\/\S+/g, " ")
    .replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, " ");

/** Leading decoration that is not the first word: bullets, quotes, emoji codes, emphasis. */
const LEAD = /^(?:\s|[-*•>#_~]|\d+[.)]\s|:[a-z0-9_+-]+:|\p{Extended_Pictographic}|️|‍)+/u;

/**
 * The first word decides. "I" (and I'm, I'll, I've, I'd) is a capital by
 * grammar, and an all-caps word of two or more letters is an acronym (PR,
 * AWS), not a capitalised sentence start.
 */
const startsWithCapital = (line: string): boolean => {
  const word = line.replace(LEAD, "").match(/^[\p{L}\p{N}'’]+/u)?.[0] ?? "";
  if (!/^\p{Lu}/u.test(word)) return false;
  if (/^I(?:['’](?:m|ll|ve|d|s))?$/u.test(word)) return false;
  const letters = word.replace(/[^\p{L}]/gu, "");
  return !(letters.length >= 2 && letters === letters.toUpperCase());
};

/** U+2190-21FF arrows, the dingbat arrows, and the long arrows. */
const ARROW = /[←-⇿➔-➿⟰-⟿⬀-⬑]/u;

/**
 * Every rule the reply breaks, at most one hit per rule (the first one), in a
 * fixed order. Language is not checked here - it needs a model.
 */
export const detectDrift = (reply: string): DriftHit[] => {
  const lines = proseOf(reply).split("\n");
  const hits: DriftHit[] = [];
  const first = (rule: DriftRule, test: (line: string) => boolean): void => {
    const line = lines.find((l) => l.trim() && test(l));
    if (line !== undefined) hits.push({ rule, excerpt: clip(line, EXCERPT_CHARS) });
  };
  first("capital", startsWithCapital);
  first("dash", (l) => /[–—]/.test(l));
  first("semicolon", (l) => l.includes(";"));
  first("arrow", (l) => ARROW.test(l));
  first("heading", (l) => /^\s{0,3}#{1,6}\s+\S/.test(l));
  first("bold", (l) => /\*\*[^*\n]+\*\*/.test(l));
  return hits;
};

/**
 * Turns the inner child itself started with a nudge open with this. Their
 * replies are never checked for drift again, so a correction that slips does
 * not get nudged, and so on.
 */
export const DRIFT_NUDGE_MARK = "inner child drift check:";

export const isDriftNudge = (request: string): boolean => request.trimStart().startsWith(DRIFT_NUDGE_MARK);

/** A link to one message, threaded when it is a reply. */
export const messageLink = (channelId: string, ts: string, threadTs = "", label = "reply"): string => {
  const base = `https://slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
  const thread = threadTs && threadTs !== ts ? `?thread_ts=${threadTs}&cid=${channelId}` : "";
  return `<${base}${thread}|${label}>`;
};

export const rulesLine = (hits: readonly DriftHit[]): string => hits.map((h) => RULE_LABEL[h.rule]).join(", ");

/**
 * What the session is told, as a turn in its own thread. Never posted there:
 * only its answer is, if it has one. Silence is spelled as a phrase the boundary
 * already drops (`isSilenceNote`), so "nothing wrong" posts nothing.
 */
export const driftNudge = (hits: readonly DriftHit[]): string =>
  [
    `${DRIFT_NUDGE_MARK} a reply you posted in this thread drifted from the voice rules: ${hits
      .map((h) => `${RULE_LABEL[h.rule]} ("${h.excerpt}")`)
      .join(", ")}.`,
    "style drift usually means the rest of that turn drifted too. re-check the CONTENT of that reply, not only the style: the facts, the commands you ran, the claims you made.",
    "if anything in it is actually wrong, correct it in a new short reply that follows the voice rules. never edit or delete the old message.",
    "if nothing in it is wrong, reply with exactly: nothing to add",
  ].join("\n");

/** The #jarvis_logs message for one drift event. Its thread gets the follow-up. */
export const driftLogMessage = (e: {
  readonly id: number;
  readonly channelId: string;
  readonly threadTs: string;
  readonly replyTs: string;
  readonly hits: readonly DriftHit[];
  readonly nudge: string;
}): string =>
  [
    `:child: drift #${e.id} in <#${e.channelId}>: ${e.replyTs ? messageLink(e.channelId, e.replyTs, e.threadTs, "drifted reply") : messageLink(e.channelId, e.threadTs, "", "thread (reply ts not found)")}`,
    `rule broken: ${rulesLine(e.hits)}`,
    ...e.hits.map((h) => `> ${h.excerpt}`),
    "nudge sent to that session (not posted in its thread):",
    "```",
    e.nudge,
    "```",
  ].join("\n");

export type DriftOutcome = "corrected" | "no_change" | "no_reply" | "failed";

/** Posted in the log message's thread once the steered turn is over. */
export const driftFollowUp = (outcome: DriftOutcome, reply: string, link = ""): string => {
  if (outcome === "corrected")
    return [`:pencil2: correction posted${link ? `: ${link}` : ""}`, ...clip(reply, 1500).split("\n").map((l) => `> ${l}`)].join(
      "\n",
    );
  if (outcome === "no_change") return ":ok_hand: no change needed, the session found nothing wrong";
  if (outcome === "failed") return `:x: the steered turn failed${reply ? `: ${clip(reply, 300)}` : ""}`;
  return ":zzz: no reply from the session";
};

/** Fingerprint for one drifted reply, so it is nudged at most once. */
export const driftKey = (channelId: string, replyTs: string, messageId: number): string =>
  `${channelId}:${replyTs || `m${messageId}`}`;

/** Letters and digits only, lowercased - Slack's mrkdwn rewrite changes everything else. */
const squash = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Which of the bot's own Slack messages in the thread is the stored reply.
 * The stored reply has no ts, so it is matched by time (posted while the turn
 * ran, or shortly after) and by its opening text; failing the text, the last
 * own message in the window. undefined when none is in the window.
 */
export const pickReplyTs = (
  messages: readonly { readonly ts: string; readonly own: boolean; readonly text: string }[],
  startedAt: number,
  endedAt: number,
  content: string,
): string | undefined => {
  const inWindow = messages.filter((m) => {
    const at = Number(m.ts) * 1000;
    return m.own && at >= startedAt - 1000 && at <= endedAt + 120_000;
  });
  const head = squash(content).slice(0, 30);
  const byText = head ? inWindow.find((m) => squash(m.text).startsWith(head)) : undefined;
  return (byText ?? inWindow[inWindow.length - 1])?.ts;
};

/** Read the language verdicts out of the triage answer: `{"drift":"language","turn":N,"excerpt":"..."}`. */
export const parseLanguageDrift = (raw: string): { turn: number; excerpt: string }[] => {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: { turn: number; excerpt: string }[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (r.drift !== "language") continue;
    const turn = typeof r.turn === "number" ? r.turn : Number(r.turn);
    if (!Number.isInteger(turn) || turn < 1) continue;
    out.push({ turn, excerpt: clip(typeof r.excerpt === "string" ? r.excerpt : "", EXCERPT_CHARS) });
  }
  return out;
};
