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

import { isSilenceNote } from "./silence.ts";

/** One message the turn put into its own thread: every text it carries (the `text` field and the words of its blocks). */
export type SelfPost = { readonly ts: string; readonly texts: readonly string[] };

/** The call a turn made, as the proxy saw it: the checked params and Slack's answer. */
export type SelfPostCall = {
  readonly method: string;
  readonly params: Readonly<Record<string, string>>;
  /** Slack's reply body; only a successful one counts. */
  readonly answer: string;
};

/**
 * The code guard only drops a NEAR-VERBATIM repeat and errs toward sending: a
 * duplicate message is a nuisance, a dropped correction, rollback or warning
 * is a person acting on a post that is now wrong. Rewording is not the code's
 * job: `jarvis_note` tells the model right after the post to end with NO_REPLY.
 *
 * Share of the post's words the reply must hold (see `repeatsPosted`): all of
 * them, so a reply that dropped a word of the post ("safe to rerun" ->
 * "safe to delete") is not a repeat. A short or different answer is kept too.
 */
export const MIN_POST_COVERAGE = 1;
/**
 * Share of the reply's words the posts do not hold (not even by their first
 * letters) up to which a reply is still a repeat. Zero: one flipped word ("is
 * not safe", "checks failed") in a long repeated reply is a correction, and a
 * share bound let it through once the reply had 20 words.
 */
export const MAX_FRESH_SHARE = 0;
/** Never a repeat when more words than this are new, however long the reply is. Zero, for the same reason: any added or swapped word keeps the reply. */
export const MAX_FRESH_WORDS = 0;
/** A sentence of the reply with more than this share of words new to the posts says something the posts did not: the reply is kept. */
export const MAX_SENTENCE_FRESH_SHARE = 0.5;
/** A reply with fewer words than this is compared only for equality: "ok, done" shares words with almost anything. */
export const MIN_WORDS = 4;
/** Words are matched by their first letters, so "scans"/"scanned" and "migrate"/"migration" meet without a stemmer or a word list for any one language. */
const STEM_LETTERS = 4;

/** Slack mrkdwn, emoji, links and punctuation out; one space between words. Case is kept only when asked. */
const cleanText = (text: string): string =>
  text
    .replace(/```[a-z]*\n?/gi, " ")
    .replace(/<@[A-Z0-9]+(?:\|[^>]*)?>|<![^>]*>|<#[A-Z0-9]+(?:\|[^>]*)?>/g, " ")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
    .replace(/:[a-z0-9_+-]+(?:::skin-tone-\d)?:/gi, " ")
    .replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, " ");

/** Lower case, punctuation out, one space between words. */
export const normalizeText = (text: string): string =>
  cleanText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const words = (text: string): string[] => normalizeText(text).split(" ").filter(Boolean);
const stemOf = (word: string): string => (word.length > STEM_LETTERS ? word.slice(0, STEM_LETTERS) : word);

/** Links of a text: what Slack shows and what it points at, as written. */
const linksIn = (text: string): string[] => text.match(/https?:\/\/[^\s<>|)\]]+/gi)?.map((l) => l.toLowerCase().replace(/[.,;:!?]+$/, "")) ?? [];

/**
 * Things a reworded repeat keeps and a new fact brings: numbers and ids (any
 * word with a digit in it), links, and names (a capitalised word that does not
 * open a sentence or a list item). Lower case, as the posts are compared.
 */
const hardTokens = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const w of words(text)) if (/\p{N}/u.test(w)) out.add(w);
  for (const l of linksIn(text)) out.add(l);
  for (const clause of cleanText(text).split(CLAUSE_BREAK)) {
    const tokens = clause.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    // the first word opens the clause; any other capitalised word of two letters or more is a name
    for (const t of tokens.slice(1)) if (t.length >= 2 && /^\p{Lu}\p{Ll}/u.test(t)) out.add(t.toLowerCase());
  }
  return out;
};

/** Where a clause ends: sentence ends, line breaks and list dashes. */
const CLAUSE_BREAK = /[.!?…]+(?:\s|$)|\n+|(?:^|\s)[-•*]\s+|:\s/;

type Known = { readonly exact: ReadonlySet<string>; readonly stems: ReadonlySet<string> };

const knownOf = (posted: readonly string[]): Known => {
  const exact = new Set<string>();
  const stems = new Set<string>();
  for (const p of posted) {
    for (const w of words(p)) {
      exact.add(w);
      stems.add(stemOf(w));
    }
    for (const l of linksIn(p)) exact.add(l);
  }
  return { exact, stems };
};

const isKnown = (word: string, known: Known): boolean => known.exact.has(word) || known.stems.has(stemOf(word));

const wordsKnown = (list: readonly string[]): Known => {
  const exact = new Set(list);
  return { exact, stems: new Set(list.map(stemOf)) };
};

/** The share of `list` that `known` does not hold, and how many words that is. */
const freshOf = (list: readonly string[], known: Known): { count: number; share: number } => {
  const count = list.filter((w) => !isKnown(w, known)).length;
  return { count, share: list.length === 0 ? 0 : count / list.length };
};

/** Sentences of a text: sentence ends, line breaks and list dashes (not the colon: "Heads up: ..." is one sentence). */
const SENTENCE_BREAK = /[.!?…]+(?:\s|$)|\n+|(?:^|\s)[-•*]\s+/;

/** Does some sentence of `text` have a majority of words new to `known`? Then it says something the posts did not, however few words that is. */
const hasNewSentence = (text: string, known: Known): boolean =>
  cleanText(text)
    .split(SENTENCE_BREAK)
    .some((sentence) => {
      const ws = words(sentence);
      return ws.length > 0 && freshOf(ws, known).share > MAX_SENTENCE_FRESH_SHARE;
    });

const bringsNewHardToken = (text: string, known: Known): boolean => [...hardTokens(text)].some((h) => !known.exact.has(h));

/**
 * Does `reply` say nothing that `posted` did not? Equal once normalised is
 * always a repeat. Otherwise, with no language assumed, ALL of these hold:
 *  1. no number, id, link or name the posts do not hold (a new fact);
 *  2. no sentence of the reply has a majority of words new to the posts (a new
 *     sentence, even a short one: "Please don't deploy anything until then.");
 *  3. the reply holds at least `MIN_POST_COVERAGE` of the posts' words (it is
 *     the post again, not a shorter or different answer);
 *  4. at most `MAX_FRESH_SHARE` and `MAX_FRESH_WORDS` of its words are new to
 *     the posts (a correction inside a repeated sentence is a few new words).
 * Any doubt keeps the reply.
 */
export const repeatsPosted = (reply: string, posted: readonly string[]): boolean => {
  const replyNorm = normalizeText(reply);
  if (!replyNorm) return false;
  if (posted.some((p) => normalizeText(p) === replyNorm)) return true;
  const replyWords = replyNorm.split(" ");
  if (replyWords.length < MIN_WORDS) return false;
  const known = knownOf(posted);
  if (bringsNewHardToken(reply, known) || hasNewSentence(reply, known)) return false;
  const postWords = posted.flatMap(words);
  if (postWords.length === 0) return false;
  const missing = freshOf(postWords, wordsKnown(replyWords));
  if (1 - missing.share < MIN_POST_COVERAGE) return false;
  const fresh = freshOf(replyWords, known);
  return fresh.count <= MAX_FRESH_WORDS && fresh.share <= MAX_FRESH_SHARE;
};

/**
 * Is a streamed part, taken alone, only what was posted (or nothing)? A part
 * may be any piece of the post, so there is no post-coverage here. A short
 * one counts only when every word of it is in the posts.
 */
export const partIsCovered = (text: string, posted: readonly string[], reply = ""): boolean => {
  const norm = normalizeText(text);
  if (!norm || isSilenceNote(text)) return true;
  // the part that holds the closing reply is the one already judged a repeat
  if (norm === normalizeText(reply)) return true;
  const ws = norm.split(" ");
  const known = knownOf(posted);
  if (bringsNewHardToken(text, known) || hasNewSentence(text, known)) return false;
  const fresh = freshOf(ws, known);
  if (ws.length < MIN_WORDS) return fresh.count === 0;
  return fresh.count <= MAX_FRESH_WORDS && fresh.share <= MAX_FRESH_SHARE;
};

/** Is the closing reply a repeat of what the turn already posted in its own thread? */
export const isDuplicateReply = (reply: string, posts: readonly SelfPost[]): boolean =>
  posts.length > 0 && repeatsPosted(reply, posts.flatMap((p) => p.texts));

/**
 * May the turn's stream be taken back? The closing reply repeats the posts AND
 * nothing else the stream showed is missing from them: `reply` is only the
 * last round's text, while earlier rounds' narration sits in the stream's
 * parts, so each part must itself be covered by the posts (a part holding the
 * repeated reply is) or be empty.
 */
export const isDuplicateStream = (reply: string, parts: readonly string[], posts: readonly SelfPost[]): boolean => {
  if (!isDuplicateReply(reply, posts)) return false;
  const posted = posts.flatMap((p) => p.texts);
  return parts.every((part) => partIsCovered(part, posted, reply));
};

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
