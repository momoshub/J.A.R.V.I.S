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
 * `text` (marker removed), or `drop` it. Only a turn with a post of its own
 * drops; a turn that opted in with the marker, and a turn that posted nothing,
 * send.
 */
export const closingReply = (reply: string, posts: readonly SelfPost[]): { readonly kind: "send"; readonly text: string } | { readonly kind: "drop" } =>
  posts.length > 0 && !hasKeepMarker(reply) ? { kind: "drop" } : { kind: "send", text: posts.length > 0 ? stripKeepMarker(reply) : reply };

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
