/**
 * The bot's side of the Slack helpers: the only place a turn's Slack call meets
 * the bot token.
 *
 * A helper in `bin/` presents the turn's ticket and a method; this checks the
 * ticket, applies the allowlist (`domain/slackProxy.ts`, the built-in lists plus the owner's extras), adds the token and
 * calls Slack. The token never leaves this closure, and what comes back is
 * Slack's own answer, unchanged, so the helpers read `ok` and `error` exactly
 * as they did when they called Slack themselves.
 *
 * Nothing about a call's content is logged, only who was refused and why.
 *
 * One call needs Slack's word before it goes out: an owner's `chat.update`
 * outside the turn's channel. The bot reads the target message first and only
 * lets the edit through when its own id wrote it (`isBotMessage`); unreadable,
 * missing or anyone else's, it is refused.
 */
import { channelParamOf, checkSlackCall, isAuditedMethod, isSlackFileUrl, type ExtraSlackMethods, type IsNotice } from "../domain/slackProxy.ts";
import { KEEP_REPLY, stripKeepMarkerFromCall } from "../domain/selfPost.ts";
import { RELAY_TTL_MS, postedNote, uploadedNote } from "../domain/threadBrief.ts";
import type { ThreadBriefRepo } from "../infrastructure/db/threadBriefRepo.ts";
import type { SelfPosts } from "./selfPosts.ts";
import type { SlackTickets, SlackTicketRefusal } from "./slackTickets.ts";

const SLACK_API = "https://slack.com/api/";
const CALL_TIMEOUT_MS = 25_000;
/** Time to get Slack's answer (headers) for a file; the body then streams for as long as it takes, bounded by size instead. */
const FILE_HEADER_TIMEOUT_MS = 100_000;
/** A private file is followed through at most this many redirects, each one re-checked. */
const MAX_REDIRECTS = 3;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

export type SlackProxyDeps = {
  tickets: SlackTickets;
  /** The bot's token. Held here and nowhere a turn can read. */
  botToken: string;
  /** Approval notices the bot posted, which a turn may not `chat.update` (see `domain/slackProxy.ts`). */
  isNotice?: IsNotice;
  /** The bot's own Slack user id; without it no message can be shown to be the bot's, so no cross-channel edit is allowed. */
  botUserId?: () => Promise<string | undefined>;
  /** Where a turn's successful posts into its own thread are noted, so the turn's closing reply can be dropped. */
  selfPosts?: SelfPosts;
  /** The methods the owner added beyond the built-in lists (`slack-methods`), read per call so a change applies at once. */
  extraMethods?: () => ExtraSlackMethods;
  /**
   * Where an owner's write into another thread files its brief (and opens the relay link back), so that thread's session
   * knows why the message is there. Without it no brief is filed.
   */
  briefs?: ThreadBriefRepo;
  /** Who the brief says asked: the owner, whose own message started the turn. */
  ownerSlackId?: string;
  clock?: () => number;
  fetchFn?: typeof fetch;
  log?: (line: string) => void;
};

/**
 * Added to Slack's answer when the turn has just put a message into its own
 * thread. The Slack handler drops the closing reply of such a turn, and a tool
 * result right after the post is read at the moment it matters.
 */
export const SELF_POST_NOTE = `this message is now in the thread the turn runs in. Your closing reply will be dropped, not posted. To add something, chat.update the message you posted, or put a line ${KEEP_REPLY} in the closing reply and it is sent (without that line)`;

/** Slack's own fields untouched, `jarvis_note` added. A body that is not a JSON object is left as it is. */
const withSelfPostNote = (body: string): string => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
    return JSON.stringify({ ...(parsed as Record<string, unknown>), jarvis_note: SELF_POST_NOTE });
  } catch {
    return body;
  }
};

export type SlackProxyReply = { readonly status: number; readonly body: string };

export type SlackFileReply =
  | { readonly ok: true; readonly body: ReadableStream<Uint8Array>; readonly contentType: string; readonly contentLength?: string }
  | { readonly ok: false; readonly status: number; readonly error: string };

export type SlackProxy = {
  call: (req: { ticket: unknown; method: unknown; params: unknown }) => Promise<SlackProxyReply>;
  download: (req: { ticket: unknown; url: unknown }) => Promise<SlackFileReply>;
};

const failure = (status: number, error: string): SlackProxyReply => ({
  status,
  body: JSON.stringify({ ok: false, error: `jarvis_proxy: ${error}` }),
});

const ticketError = (reason: SlackTicketRefusal, limit: number): string =>
  reason === "spent"
    ? `this turn has already made its ${limit} Slack calls, which is the runaway guard - finish up and say what is left`
    : "that Slack ticket is not valid (it belongs to a turn that has ended, or this turn has none)";

/** Errors the stream past `max` bytes, so a body with no content-length is bounded too and the client sees a failed transfer, not a short file. */
export const capBytes = (body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> => {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new Error("file is too large"));
        else controller.enqueue(chunk);
      },
    }),
  );
};

/** Did the bot write this message? `user` is the bot's own id; a webhook or another app's post carries a different one. */
export const isBotMessage = (message: unknown, botUserId: string | undefined): boolean => {
  if (!botUserId || !message || typeof message !== "object") return false;
  return (message as { user?: unknown }).user === botUserId;
};


type Landed = { channel: string; thread: string; note: string };

/** `files` is a JSON string of `[{id, title}]`; anything else gives no titles. */
const uploadTitles = (raw: string | undefined): string[] => {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((f) => (f && typeof f === "object" && typeof (f as { title?: unknown }).title === "string" ? [(f as { title: string }).title] : []));
  } catch {
    return [];
  }
};

/**
 * Where an accepted post or upload completion landed, and the brief text for it, or undefined when Slack's answer does not
 * say which thread (an upload with no `thread_ts` whose answer lists no share). A top-level post names its own ts.
 */
export const landedWrite = (method: string, params: Record<string, string>, answer: string, actor: string): Landed | undefined => {
  let body: { ok?: boolean; ts?: string; message?: { ts?: string }; files?: { shares?: Record<string, Record<string, { ts?: string }[]>> }[] };
  try {
    body = JSON.parse(answer) as typeof body;
  } catch {
    return undefined;
  }
  if (body?.ok !== true) return undefined;
  if (method === "chat.postMessage") {
    const channel = params.channel;
    const thread = params.thread_ts?.trim() || body.ts || body.message?.ts;
    if (!channel || !thread) return undefined;
    return { channel, thread, note: postedNote(actor, params.text?.trim() || "(no text, a formatted message)") };
  }
  if (method === "files.completeUploadExternal") {
    const channel = params.channel_id;
    if (!channel) return undefined;
    let thread = params.thread_ts?.trim();
    if (!thread) {
      for (const file of body.files ?? []) {
        for (const kind of Object.values(file.shares ?? {})) thread ??= kind[channel]?.[0]?.ts;
      }
    }
    if (!thread) return undefined;
    return { channel, thread, note: uploadedNote(actor, uploadTitles(params.files), params.initial_comment ?? "") };
  }
  return undefined;
};

export const createSlackProxy = (deps: SlackProxyDeps): SlackProxy => {
  const doFetch = deps.fetchFn ?? fetch;
  const log = deps.log ?? (() => {});

  // One brief per turn and target thread: the first write carries the reason, and the rest of that turn's writes there say the same thing.
  const briefed = new Set<string>();

  /**
   * An owner's write that lands in a thread other than the turn's own files a brief there, same shape as `post`, and starts or
   * renews the relay link back. Never throws and never changes what the turn gets back.
   */
  const briefWrite = (ctx: { channel?: string; threadTs?: string; turn?: string; owner?: boolean }, ticket: unknown, checked: { method: string }, sent: Record<string, string>, answer: string): void => {
    if (!deps.briefs || !deps.ownerSlackId || !ctx.owner || !ctx.channel || !ctx.threadTs) return;
    try {
      const landed = landedWrite(checked.method, sent, answer, deps.ownerSlackId);
      if (!landed) return;
      if (landed.channel === ctx.channel && landed.thread === ctx.threadTs) return;
      const now = (deps.clock ?? Date.now)();
      const source = { channelId: ctx.channel, threadTs: ctx.threadTs };
      const target = { channelId: landed.channel, threadTs: landed.thread };
      deps.briefs.noteWrite(source, target, now, RELAY_TTL_MS);
      const key = `${ctx.turn ?? String(ticket)}|${landed.channel}|${landed.thread}`;
      if (briefed.has(key)) return;
      if (briefed.size > 2000) briefed.clear();
      briefed.add(key);
      deps.briefs.add(
        { fromChannel: ctx.channel, fromThread: ctx.threadTs, toChannel: landed.channel, toThread: landed.thread, author: deps.ownerSlackId, text: landed.note },
        now,
      );
      log(`slack proxy filed a brief for ${checked.method} channel=${landed.channel}`);
    } catch (e) {
      log(`slack proxy could not file a brief for ${checked.method}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const redeem = (ticket: unknown) =>
    typeof ticket === "string" && ticket ? deps.tickets.redeem(ticket.trim()) : ({ ok: false, reason: "unknown", limit: 0 } as const);

  const readSlack = async (method: string, params: Record<string, string>): Promise<{ ok?: boolean; messages?: unknown[] } | undefined> => {
    const res = await doFetch(`${SLACK_API}${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.botToken}`, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    return (await res.json().catch(() => undefined)) as { ok?: boolean; messages?: unknown[] } | undefined;
  };

  /**
   * True only when Slack shows the message at `ts` and the bot wrote it. A top-level message comes from `conversations.history`,
   * a thread reply only from `conversations.replies` (which starts at the thread's parent, so the read is bounded to that ts and the match is on the exact ts, never `messages[0]`), so both are tried; any error or an empty answer is "not shown" (fail closed).
   */
  const botWrote = async (channel: string, ts: string): Promise<boolean> => {
    const me = await deps.botUserId?.().catch(() => undefined);
    if (!me) return false;
    const found = async (method: string, params: Record<string, string>): Promise<unknown> => {
      const answer = await readSlack(method, params).catch(() => undefined);
      return answer?.ok ? answer.messages?.find((m) => (m as { ts?: unknown }).ts === ts) : undefined;
    };
    const message =
      (await found("conversations.history", { channel, latest: ts, oldest: ts, inclusive: "true", limit: "1" })) ??
      (await found("conversations.replies", { channel, ts, oldest: ts, latest: ts, inclusive: "true", limit: "10" }));
    return isBotMessage(message, me);
  };

  return {
    call: async ({ ticket, method, params }) => {
      const resolved = redeem(ticket);
      if (!resolved.ok) return failure(401, ticketError(resolved.reason, resolved.limit));
      const extra = deps.extraMethods?.() ?? [];
      const checked = checkSlackCall(
        method,
        params,
        { channel: resolved.ctx.channel, threadTs: resolved.ctx.threadTs, owner: resolved.ctx.owner },
        deps.isNotice,
        extra,
      );
      if (!checked.ok) {
        log(`slack proxy refused ${String(method)}: ${checked.error}`);
        return failure(checked.status, checked.error);
      }
      // the keep-reply marker is an instruction to the bot: it never goes into a message the turn writes itself
      const stripped = stripKeepMarkerFromCall(checked.method, checked.params);
      if (stripped.kind === "empty") {
        log(`slack proxy refused ${checked.method}: nothing left after the keep-reply marker was removed`);
        return failure(400, "no_text: the message was only the closing-reply marker, which is never posted, so nothing was sent");
      }
      const sendParams = stripped.params;
      if (checked.ownMessageIn) {
        const { channel, ts } = checked.ownMessageIn;
        if (!(await botWrote(channel, ts))) {
          log(`slack proxy refused ${checked.method} outside the turn's channel: channel=${channel} ts=${ts} is not shown to be the bot's own message`);
          return failure(403, "message_not_allowed: chat.update outside this turn's channel only edits a message the bot itself wrote, and Slack did not show that for this one");
        }
        log(`slack proxy ${checked.method} channel=${channel} ts=${ts} (owner's turn, the bot's own message outside the turn's channel)`);
      } else if (isAuditedMethod(checked.method, extra)) {
        // method and channel only, never the content
        const param = channelParamOf(checked.method, extra);
        const where = (param && sendParams[param]) || sendParams.channel || sendParams.channel_id || "-";
        log(`slack proxy ${checked.method} channel=${where}${checked.crossChannel ? " (owner's turn, outside the turn's channel)" : ""}`);
      }
      try {
        const res = await doFetch(`${SLACK_API}${checked.method}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${deps.botToken}`,
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          },
          body: new URLSearchParams(sendParams).toString(),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        const text = await res.text();
        if (res.status === 429) {
          // Slack's retry hint is a header; the helpers only see the body.
          const retryAfter = Number(res.headers.get("retry-after"));
          return {
            status: 429,
            body: JSON.stringify({ ok: false, error: "ratelimited", ...(Number.isFinite(retryAfter) ? { retry_after: retryAfter } : {}) }),
          };
        }
        if (res.ok && !checked.ownMessageIn) briefWrite(resolved.ctx, ticket, checked, sendParams, text);
        // noted per turn, only what Slack accepted, and only into the turn's own thread (an owner's post in another channel is not)
        if (res.ok && checked.method.startsWith("chat.") && resolved.ctx.turn && !checked.ownMessageIn && !checked.crossChannel) {
          const landed = deps.selfPosts?.record(resolved.ctx.turn, resolved.ctx.threadTs, { method: checked.method, params: sendParams, answer: text });
          if (landed) return { status: res.status, body: withSelfPostNote(text) };
        }
        return { status: res.status, body: text };
      } catch (e) {
        log(`slack proxy could not reach Slack for ${checked.method}: ${e instanceof Error ? e.message : String(e)}`);
        return failure(502, "Slack did not answer");
      }
    },

    download: async ({ ticket, url }) => {
      const resolved = redeem(ticket);
      if (!resolved.ok) return { ok: false, status: 401, error: ticketError(resolved.reason, resolved.limit) };
      if (!isSlackFileUrl(url)) return { ok: false, status: 403, error: "not a Slack file url" };
      let target = url as string;
      try {
        // The token goes to a host only after that exact url passed the check, and every redirect is checked again.
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          // the timer covers the wait for headers only: a signal on fetch would also cut a slow body mid-stream, after the 200 was sent
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), FILE_HEADER_TIMEOUT_MS);
          let res: Response;
          try {
            res = await doFetch(target, {
              headers: { Authorization: `Bearer ${deps.botToken}` },
              redirect: "manual",
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }
          if (res.status >= 300 && res.status < 400) {
            const next = res.headers.get("location");
            const absolute = next ? new URL(next, target).toString() : "";
            if (!isSlackFileUrl(absolute)) return { ok: false, status: 403, error: "redirected away from Slack" };
            target = absolute;
            continue;
          }
          if (!res.ok || !res.body) return { ok: false, status: res.status === 200 ? 502 : res.status, error: `download failed (http ${res.status})` };
          const length = Number(res.headers.get("content-length"));
          if (Number.isFinite(length) && length > MAX_FILE_BYTES) return { ok: false, status: 413, error: "file is too large" };
          return {
            ok: true,
            body: capBytes(res.body, MAX_FILE_BYTES),
            contentType: res.headers.get("content-type") ?? "application/octet-stream",
            ...(res.headers.get("content-length") ? { contentLength: res.headers.get("content-length") as string } : {}),
          };
        }
        return { ok: false, status: 502, error: "too many redirects" };
      } catch (e) {
        log(`slack proxy could not download a file: ${e instanceof Error ? e.message : String(e)}`);
        return { ok: false, status: 502, error: "Slack did not answer" };
      }
    },
  };
};
