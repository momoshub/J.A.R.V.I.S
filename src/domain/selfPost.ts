/**
 * A turn that posted its answer itself does not stream a closing reply.
 *
 * A turn may post into its own thread through the Slack proxy (`chat.postMessage`,
 * later `chat.update`). Its closing reply would then be a second copy of the
 * answer, usually reworded, and no comparison of words tells a reword from a
 * correction reliably. So the default is inverted: once the turn has put a
 * message into its own thread, its closing reply is dropped, unless the turn
 * opts in with `KEEP_REPLY` on a line of its own (or as the closing token) in that reply.
 *
 * Pure: no I/O. The record of what a turn posted lives in `application/selfPosts.ts`.
 */

/** One message the turn put into its own thread. */
export type SelfPost = { readonly ts: string };

/** The call a turn made, as the proxy saw it: the checked params and Slack's answer. */
export type SelfPostCall = {
  readonly method: string;
  readonly params: Readonly<Record<string, string>>;
  /** Slack's reply body; only a successful one counts. */
  readonly answer: string;
};

/** The line a closing reply carries to be sent although the turn posted its answer itself. */
export const KEEP_REPLY = "KEEP_REPLY";

const KEEP_LINE = /^[ \t]*KEEP_REPLY[ \t]*$/m;
const KEEP_LINES = /^[ \t]*KEEP_REPLY[ \t]*(?:\r?\n|$)/gm;
// the same token closing a text after other words on its line; a longer word that merely ends in it does not count
const KEEP_TRAILING = /(?<![A-Za-z0-9_])KEEP_REPLY[ \t]*$/;

/** Does the text carry the `KEEP_REPLY` marker: on a line of its own, or as the token that closes it? */
export const hasKeepMarker = (reply: string): boolean => KEEP_LINE.test(reply) || KEEP_TRAILING.test(reply.trimEnd());

/** The text without its marker lines and closing marker token, trimmed. */
export const stripKeepMarker = (reply: string): string => reply.replace(KEEP_LINES, "").trimEnd().replace(KEEP_TRAILING, "").trim();

/**
 * Walks Slack blocks and removes the marker from every `text` string. An object whose own `text` was only the
 * marker says nothing and is dropped from its parent (an array entry, or the property holding it, which drops
 * that parent in turn). `undefined` means "this node is gone".
 */
const cleanNode = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(cleanNode).filter((n) => n !== undefined);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "text" && typeof value === "string" && hasKeepMarker(value)) {
      const text = stripKeepMarker(value);
      if (!text) return undefined;
      out[key] = text;
      continue;
    }
    const cleaned = cleanNode(value);
    if (cleaned === undefined && value !== undefined) return undefined;
    out[key] = cleaned;
  }
  return out;
};

/** What the proxy sends for a `chat.postMessage` / `chat.update` after the marker is taken out: the params, or nothing left to say. */
export type MarkerStrip = { readonly kind: "send"; readonly params: Readonly<Record<string, string>> } | { readonly kind: "empty" };

/**
 * The marker is an instruction to the bot, so it never goes into a message the turn writes itself. Taken out of `text`
 * and of the `text` fields in `blocks` of `chat.postMessage` and `chat.update`; any other call, any text without the
 * marker and any blocks that are not JSON go through as they came. A call whose text and blocks held only the marker
 * (and that has no attachments) is `empty`: it must not post or blank a message.
 */
export const stripKeepMarkerFromCall = (method: string, params: Readonly<Record<string, string>>): MarkerStrip => {
  if (method !== "chat.postMessage" && method !== "chat.update") return { kind: "send", params };
  const out: Record<string, string> = { ...params };
  let touched = false;
  if (out.text !== undefined && hasKeepMarker(out.text)) {
    touched = true;
    const text = stripKeepMarker(out.text);
    if (text) out.text = text;
    else delete out.text;
  }
  if (out.blocks !== undefined && out.blocks.includes(KEEP_REPLY)) {
    try {
      const blocks = JSON.parse(out.blocks) as unknown;
      const cleaned = cleanNode(blocks);
      if (JSON.stringify(cleaned) !== JSON.stringify(blocks)) {
        touched = true;
        if (Array.isArray(cleaned) && cleaned.length > 0) out.blocks = JSON.stringify(cleaned);
        else delete out.blocks;
      }
    } catch {
      // not JSON: Slack will say so
    }
  }
  if (touched && !out.text?.trim() && out.blocks === undefined && !out.attachments) return { kind: "empty" };
  return { kind: "send", params: touched ? out : params };
};

/**
 * What the Slack handler does with the closing reply of a turn: `send` it as
 * `text`, or `drop` it. The marker is an instruction to the bot, so it is
 * stripped whenever it is there, posts or not, and a reply that was only the
 * marker says nothing and is dropped. Without the marker, a turn with a post
 * of its own drops and a turn that posted nothing sends the reply as it is.
 */
export const closingReply = (reply: string, posts: readonly SelfPost[]): { readonly kind: "send"; readonly text: string } | { readonly kind: "drop" } => {
  if (!hasKeepMarker(reply)) return posts.length > 0 ? { kind: "drop" } : { kind: "send", text: reply };
  const text = stripKeepMarker(reply);
  return text ? { kind: "send", text } : { kind: "drop" };
};

/** Could `line` still grow into a marker line (`KEEP_REPLY` with optional blanks around it)? */
const mayBecomeMarker = (line: string): boolean => {
  const body = line.trimStart();
  const word = body.trimEnd();
  if (body === "") return true;
  return word === body ? KEEP_REPLY.startsWith(body) : word === KEEP_REPLY;
};

/** Filters marker lines out of streamed text, chunk by chunk. */
export type KeepMarkerFilter = {
  /** The part of the stream that is safe to show now; may be empty while a line is undecided. */
  readonly push: (delta: string) => string;
  /** The held trailing line at the end of the stream, unless it is a marker line. */
  readonly flush: () => string;
};

/**
 * Stream deltas carry the marker before the final reply is tidied, and a chunk
 * can split the token (`KEEP_` + `REPLY`). Complete lines are released minus the
 * marker lines; the trailing partial line is held while it could still become a
 * marker line, and released as soon as it cannot.
 */
export const createKeepMarkerFilter = (): KeepMarkerFilter => {
  let pending = "";
  const lineOut = (line: string): string => (KEEP_LINE.test(line.replace(/\r?\n$/, "")) ? "" : line);
  return {
    push: (delta) => {
      pending += delta;
      const cut = pending.lastIndexOf("\n") + 1;
      const complete = pending.slice(0, cut);
      pending = pending.slice(cut);
      let out = complete.split(/(?<=\n)/).map(lineOut).join("");
      if (pending && !mayBecomeMarker(pending)) {
        out += pending;
        pending = "";
      }
      return out;
    },
    flush: () => {
      const rest = lineOut(pending);
      pending = "";
      return rest;
    },
  };
};

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
    return posts.some((p) => p.ts === answer.ts) ? posts : [...posts, { ts: answer.ts }];
  }
  if (call.method === "chat.update") {
    const ts = call.params.ts;
    // an update of a message this turn posted keeps the turn marked as having posted
    return ts && posts.some((p) => p.ts === ts) ? [...posts] : posts;
  }
  return posts;
};
