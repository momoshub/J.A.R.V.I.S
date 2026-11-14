/**
 * Stale promises: a turn that ended on "next I will ..." with nothing left
 * running to do it. The bot's last message is its own, it promises more work,
 * and no watch, reminder, worker or turn exists for the thread, so the work
 * stalls until a person prods it. The sweep (application/stalePromiseSweep.ts)
 * finds such threads and steers their session once.
 *
 * Everything that decides anything is here, with no I/O: the cheap bilingual
 * (English + Vietnamese) promise heuristic, the model's question and answer,
 * which threads are eligible, the nudge text and the once-only record.
 */

export const DEFAULT_SWEEP_INTERVAL_MS = 15 * 60_000;
/** A promise younger than this may still be about to happen. */
export const DEFAULT_MIN_AGE_MS = 30 * 60_000;
/** Threads the bot was active in within this long are looked at. */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60_000;
export const DEFAULT_MAX_NUDGES = 3;
/** How long a nudged message is remembered; past the window it can no longer be a candidate. */
const SEEN_KEEP_MS = 2 * DEFAULT_WINDOW_MS;

/** Slack ts (`1731600000.000200`) as ms. NaN when it is not one. */
export const tsMs = (ts: string): number => Number(ts) * 1000;

const strip = (text: string): string =>
  text
    .normalize("NFC")
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Offers and questions put the next move to the human: not a promise. */
const OFFER = [
  /\b(if you('d)? (like|want|prefer)|would you like|do you want|want me to|shall i|should i|let me know|just say|tell me (if|when|which))\b/,
  /(bạn|anh|chị|sếp) (có )?muốn|muốn em|cần em|nếu (bạn|anh|chị|sếp) (muốn|cần)|cho em biết|báo em|bảo em/u,
];

/**
 * First-person intent to do work. English: "next I will", "I'll update",
 * "next step is", "once X, I'll ...". Vietnamese: "việc tiếp theo là",
 * "bước tiếp theo", "em sẽ ...", "xong em gửi", "lát nữa em ...". The pronoun
 * is required where the phrase would otherwise match advice or a report.
 */
const PROMISE: readonly RegExp[] = [
  /\bnext(,| up)? (step|thing|i('| wi)ll|up i('| wi)ll|is (to|for me))\b/,
  /\b(i('| wi)ll|i am going to|i'm going to|i'm gonna) (now |then |also |shortly |soon |next )?(update|fix|send|post|check|follow|get|finish|continue|rewrite|revise|push|open|create|run|write|draft|look|make|ping|come back|circle back|report|share|add|apply|merge)\b/,
  /\b(once|after|when) (that|this|it|those|the \w+( \w+)?) (is|are|has|have|finish\w*|done|complete\w*|lands?|merges?|passes?)[^.!?\n]{0,60}\b(i('| wi)ll|i can)\b/,
  /(?<![\p{L}])(việc|bước|phần|thứ|điều) (tiếp theo|kế tiếp|tiếp)( là| em| mình)/u,
  /(?<![\p{L}])tiếp theo,? (là |em |mình |tôi )/u,
  /(?<![\p{L}])(em|mình|tôi) (sẽ|xin) (sửa|cập nhật|gửi|làm|kiểm tra|đăng|chạy|viết|soạn|báo|thông báo|tiếp tục|hoàn thiện|hoàn thành|xử lý|check|update|fix|post|push|mở|tạo|merge)/u,
  /(?<![\p{L}])(xong|sau đó|rồi|lát nữa|chút nữa|sau khi [^.!?\n]{1,40}) (em|mình|tôi) (sẽ )?(gửi|sửa|cập nhật|làm|báo|đăng|check|update|post|chạy|kiểm tra|xử lý)/u,
  /(?<![\p{L}])(để|đợi|chờ) (em|mình) (làm|sửa|cập nhật|gửi|check|chạy|xử lý|kiểm tra)(?![^.!?\n]*\?)/u,
];

/**
 * Whether a message reads like the bot promising further work. A question to
 * the human (the last sentence ends in `?`), an offer ("if you want, I can") or
 * plain text with no first-person intent is not a promise. Conservative: the
 * sweep asks a model to confirm a match, and without one trusts only this.
 */
export const looksLikePromise = (text: string): boolean => {
  const t = strip(text).slice(-1200);
  if (!t) return false;
  const lastSentence = t.split(/(?<=[.!])\s+/).pop() ?? t;
  if (/[?？]\s*$/.test(lastSentence)) return false;
  if (OFFER.some((re) => re.test(lastSentence))) return false;
  return PROMISE.some((re) => re.test(t));
};

export const classifySystem = (botName: string): string =>
  `You read the last message ${botName} (a chat assistant) posted in a thread. Answer YES only if that message promises ${botName} will do further work itself and the work is not done yet ("next I will update the post", "xong em gửi báo cáo", "việc tiếp theo là sửa bài"). Answer NO for a finished answer, a report of work already done, a question or offer to the human, or advice. Answer with the single word YES or NO.`;

export const classifyMessage = (lastMessage: string): string =>
  `Last message:\n"""\n${lastMessage.slice(-1500)}\n"""`;

/** An unreadable answer is NO: the sweep never nudges on a guess. */
export const parsePromiseVerdict = (raw: string): boolean => /^\s*yes\b/i.test(raw.trim());

export type ThreadFacts = {
  /** The newest message in the thread is the bot's own. */
  readonly lastIsOwn: boolean;
  /** Slack ts of that newest message. */
  readonly lastTs: string;
  readonly now: number;
  readonly minAgeMs: number;
  readonly turnRunning: boolean;
  readonly workflowActive: boolean;
  readonly watches: number;
  readonly reminders: number;
  readonly liveWorker: boolean;
  /** Slack ts of the last message already nudged in this thread. */
  readonly nudgedTs?: string;
};

export type Eligibility = { readonly ok: true } | { readonly ok: false; readonly why: string };

/** Whether a thread's state allows a nudge (the promise itself is judged separately). */
export const eligible = (f: ThreadFacts): Eligibility => {
  if (!f.lastIsOwn) return { ok: false, why: "last message is not the bot's" };
  const age = f.now - tsMs(f.lastTs);
  if (!Number.isFinite(age)) return { ok: false, why: "unreadable message ts" };
  if (age < f.minAgeMs) return { ok: false, why: "too recent" };
  if (f.nudgedTs === f.lastTs) return { ok: false, why: "already nudged" };
  if (f.turnRunning) return { ok: false, why: "a turn is running" };
  if (f.workflowActive) return { ok: false, why: "workflow thread" };
  if (f.watches > 0) return { ok: false, why: "a watch is waiting" };
  if (f.reminders > 0) return { ok: false, why: "a reminder is waiting" };
  if (f.liveWorker) return { ok: false, why: "a worker is live" };
  return { ok: true };
};

export const nudgeText = (ageMs: number): string => {
  const minutes = Math.max(1, Math.round(ageMs / 60_000));
  return `Your last message in this thread promised further work ${minutes} minutes ago, and nothing has happened since: no turn is running and no watch, reminder or worker is waiting for it. Do the work now. If it needs to wait on something, set a watch or a reminder for it. If nothing is actually pending (the message was only an answer), post nothing and end the turn with NO_REPLY.`;
};

/** thread key -> the bot message ts last nudged, and when. */
export type NudgedMap = Record<string, { readonly ts: string; readonly at: number }>;

export const threadKey = (channelId: string, threadTs: string): string => `${channelId}:${threadTs}`;

export const parseNudged = (raw: string | undefined): NudgedMap => {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: NudgedMap = {};
    for (const [k, e] of Object.entries(v)) {
      if (e && typeof e === "object" && "ts" in e && "at" in e && typeof e.ts === "string" && typeof e.at === "number") {
        out[k] = { ts: e.ts, at: e.at };
      }
    }
    return out;
  } catch {
    return {};
  }
};

/** Drops records too old to matter, so the setting does not grow forever. */
export const pruneNudged = (map: NudgedMap, now: number): NudgedMap =>
  Object.fromEntries(Object.entries(map).filter(([, e]) => now - e.at < SEEN_KEEP_MS));
