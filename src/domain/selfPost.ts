/**
 * A turn that posted its answer itself does not stream a closing reply.
 *
 * A turn may post into its own thread through the Slack proxy (`chat.postMessage`,
 * later `chat.update`). Its closing reply would then be a second copy of the
 * answer, usually reworded, and no comparison of words tells a reword from a
 * correction reliably. So the default is inverted: once the turn has put a
 * message into its own thread, its closing reply is dropped, unless the turn
 * opts in with `KEEP_REPLY` on a line of its own in that reply.
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

/** Does the closing reply carry the `KEEP_REPLY` marker line? */
export const hasKeepMarker = (reply: string): boolean => KEEP_LINE.test(reply);

/** The reply without its marker lines, trimmed. */
export const stripKeepMarker = (reply: string): string => reply.replace(KEEP_LINES, "").trim();

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
