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
 * Share of a reply's words the posts do not hold (not even by their first
 * letters) up to which it is still a repeat. Rewording moves some words and a
 * reword says a little about the post itself ("I updated the message above"),
 * so it is not zero.
 */
export const MAX_FRESH_SHARE = 0.2;
/** Never a repeat when more words than this are new, however long the reply is: twenty percent of a long reply is a paragraph. */
export const MAX_FRESH_WORDS = 20;
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

/**
 * Does `reply` say nothing that `posted` did not? Equal once normalised is
 * always a repeat. Otherwise, with no language assumed:
 *  - a number, id, link or name the posts do not hold is a new fact: not a repeat;
 *  - only a small share of its words may be new to the posts, which is how a
 *    reword with a closing "I updated the message above" sentence stays a
 *    repeat while a new paragraph does not.
 */
export const repeatsPosted = (reply: string, posted: readonly string[]): boolean => {
  const replyNorm = normalizeText(reply);
  if (!replyNorm) return false;
  if (posted.some((p) => normalizeText(p) === replyNorm)) return true;
  const known = knownOf(posted);
  const replyWords = replyNorm.split(" ");
  if (replyWords.length < MIN_WORDS) return false;
  for (const h of hardTokens(reply)) if (!known.exact.has(h)) return false;
  const fresh = replyWords.filter((w) => !isKnown(w, known)).length;
  return fresh <= MAX_FRESH_WORDS && fresh / replyWords.length <= MAX_FRESH_SHARE;
};

/**
 * Is a streamed part, taken alone, only what was posted (or nothing)? A short
 * one counts only when every word of it is in the posts.
 */
export const partIsCovered = (text: string, posted: readonly string[]): boolean => {
  const norm = normalizeText(text);
  if (!norm || isSilenceNote(text)) return true;
  const ws = norm.split(" ");
  if (ws.length >= MIN_WORDS) return repeatsPosted(text, posted);
  const known = knownOf(posted);
  return ws.every((w) => isKnown(w, known)) && [...hardTokens(text)].every((h) => known.exact.has(h));
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
  return parts.every((part) => partIsCovered(part, posted));
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
