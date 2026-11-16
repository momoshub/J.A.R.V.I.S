/**
 * A turn that posted its answer itself must not also stream it.
 *
 * A turn may post into its own thread through the Slack proxy (`chat.postMessage`,
 * later `chat.update`). When its closing reply is the same answer reworded, the
 * thread ends up with the answer twice. The prompt tells the model to end with
 * NO_REPLY in that case, and a prompt rule is not a guarantee, so the bot also
 * compares the closing reply with what the turn already posted and takes the
 * reply back when it adds nothing.
 *
 * Pure: no I/O. The log of what a turn posted lives in `application/selfPosts.ts`.
 */

/** One message the turn put into its own thread: every text it carries (the `text` field and the words of its blocks). */
export type SelfPost = { readonly ts: string; readonly texts: readonly string[] };

/** The call a turn made, as the proxy saw it: the checked params and Slack's answer. */
export type SelfPostCall = {
  readonly method: string;
  readonly params: Readonly<Record<string, string>>;
  /** Slack's reply body; only a successful one counts. */
  readonly answer: string;
};

/** Words that carry no content, so rewording around them does not move the comparison. */
const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "a an the and or but if so as at by for from in into of on onto to with without is are was were be been being am do does did done have has had " +
    "it its this that these those i me my we our you your they them their he she his her there here then than just also now not no yes " +
    "can could will would should shall may might must about over after before up down out off again still very more most some any all each " +
    "which who whom what when where why how too only own same such both few other another"
  ).split(" "),
);

/**
 * Words under this share of a reply's content that are new (not in what was
 * posted) make it a repeat. Rewording moves some words, so it is not zero.
 */
export const MAX_NEW_SHARE = 0.2;
/** Never a repeat when it brings more new words than this, however long it is: twenty percent of a long reply is a paragraph. */
export const MAX_NEW_WORDS = 5;
/** A reply with fewer content words than this is compared only for equality: "ok, done" shares words with almost anything. */
export const MIN_CONTENT_WORDS = 4;

/** Slack mrkdwn, emoji, links and punctuation out; lower case; one space between words. */
export const normalizeText = (text: string): string =>
  text
    .replace(/```[a-z]*\n?/gi, " ")
    .replace(/<@[A-Z0-9]+(?:\|[^>]*)?>|<![^>]*>|<#[A-Z0-9]+(?:\|[^>]*)?>/g, " ")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
    .replace(/:[a-z0-9_+-]+(?:::skin-tone-\d)?:/gi, " ")
    .replace(/[\p{Extended_Pictographic}‍️]/gu, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Crude suffix stripping: enough that "updated"/"updating"/"updates" meet, not a real stemmer. */
const stem = (word: string): string => {
  if (word.length <= 4) return word;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length);
  }
  return word;
};

/** The content words of a text, as a set. */
export const contentWords = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const word of normalizeText(text).split(" ")) {
    if (!word || STOPWORDS.has(word)) continue;
    out.add(stem(word));
  }
  return out;
};

/**
 * Does `reply` say nothing that `posted` did not? Equal once normalised is
 * always a repeat; otherwise the reply's content words must be covered by the
 * posted texts together, with only a few words (and a small share) left over.
 */
export const repeatsPosted = (reply: string, posted: readonly string[]): boolean => {
  const replyNorm = normalizeText(reply);
  if (!replyNorm) return false;
  if (posted.some((p) => normalizeText(p) === replyNorm)) return true;
  const words = contentWords(reply);
  if (words.size < MIN_CONTENT_WORDS) return false;
  const known = new Set<string>();
  for (const p of posted) for (const w of contentWords(p)) known.add(w);
  let fresh = 0;
  for (const w of words) if (!known.has(w)) fresh += 1;
  return fresh <= MAX_NEW_WORDS && fresh / words.size <= MAX_NEW_SHARE;
};

/** Is the closing reply a repeat of what the turn already posted in its own thread? */
export const isDuplicateReply = (reply: string, posts: readonly SelfPost[]): boolean =>
  posts.length > 0 && repeatsPosted(reply, posts.flatMap((p) => p.texts));

/** The words of a `blocks` JSON string: section, header, markdown, context and rich text elements. Unparseable: nothing. */
export const blocksText = (raw: string | undefined): string => {
  if (!raw) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (typeof rec.text === "string") parts.push(rec.text);
    else if (rec.text && typeof rec.text === "object") walk(rec.text);
    for (const key of ["elements", "fields", "accessory"]) if (key in rec) walk(rec[key]);
  };
  walk(parsed);
  return parts.join("\n");
};

const textsOf = (params: Readonly<Record<string, string>>): string[] =>
  [params.text ?? "", blocksText(params.blocks)].filter((t) => t.trim() !== "");

const answerOf = (raw: string): { ok: boolean; ts?: string } => {
  try {
    const body = JSON.parse(raw) as { ok?: unknown; ts?: unknown; message?: { ts?: unknown } };
    const ts = typeof body.ts === "string" ? body.ts : typeof body.message?.ts === "string" ? body.message.ts : undefined;
    return { ok: body.ok === true, ...(ts ? { ts } : {}) };
  } catch {
    return { ok: false };
  }
};

/**
 * What a turn's call did to its own thread's messages: the new list of posts.
 * A post counts only when it succeeded and landed in the turn's own thread
 * (`thread_ts` is the turn's thread, which the proxy fills in when omitted); an
 * update counts only for a message this turn posted there, since a ts alone
 * does not say which thread a message sits in. Anything else: the list as it was.
 */
export const applySelfPostCall = (posts: readonly SelfPost[], call: SelfPostCall, threadTs: string | undefined): readonly SelfPost[] => {
  if (!threadTs) return posts;
  const answer = answerOf(call.answer);
  if (!answer.ok) return posts;
  if (call.method === "chat.postMessage") {
    if (call.params.thread_ts !== threadTs || !answer.ts) return posts;
    const texts = textsOf(call.params);
    return texts.length === 0 ? posts : [...posts.filter((p) => p.ts !== answer.ts), { ts: answer.ts, texts }];
  }
  if (call.method === "chat.update") {
    const ts = call.params.ts;
    if (!ts || !posts.some((p) => p.ts === ts)) return posts;
    // An update that sends no text or blocks leaves the message's words as they are.
    const texts = textsOf(call.params);
    if (texts.length === 0) return posts;
    return posts.map((p) => (p.ts === ts ? { ts, texts } : p));
  }
  return posts;
};
