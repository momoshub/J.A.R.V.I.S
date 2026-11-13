/**
 * The bot's side of the Slack helpers: the only place a turn's Slack call meets
 * the bot token.
 *
 * A helper in `bin/` presents the turn's ticket and a method; this checks the
 * ticket, applies the allowlist (`domain/slackProxy.ts`), adds the token and
 * calls Slack. The token never leaves this closure, and what comes back is
 * Slack's own answer, unchanged, so the helpers read `ok` and `error` exactly
 * as they did when they called Slack themselves.
 *
 * Nothing about a call's content is logged, only who was refused and why.
 */
import { checkSlackCall, isAuditedMethod, isSlackFileUrl } from "../domain/slackProxy.ts";
import type { SlackTickets, SlackTicketRefusal } from "./slackTickets.ts";

const SLACK_API = "https://slack.com/api/";
const CALL_TIMEOUT_MS = 25_000;
/** A private file is followed through at most this many redirects, each one re-checked. */
const MAX_REDIRECTS = 3;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

export type SlackProxyDeps = {
  tickets: SlackTickets;
  /** The bot's token. Held here and nowhere a turn can read. */
  botToken: string;
  fetchFn?: typeof fetch;
  log?: (line: string) => void;
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

export const createSlackProxy = (deps: SlackProxyDeps): SlackProxy => {
  const doFetch = deps.fetchFn ?? fetch;
  const log = deps.log ?? (() => {});

  const redeem = (ticket: unknown) =>
    typeof ticket === "string" && ticket ? deps.tickets.redeem(ticket.trim()) : ({ ok: false, reason: "unknown", limit: 0 } as const);

  return {
    call: async ({ ticket, method, params }) => {
      const resolved = redeem(ticket);
      if (!resolved.ok) return failure(401, ticketError(resolved.reason, resolved.limit));
      const checked = checkSlackCall(method, params, { channel: resolved.ctx.channel });
      if (!checked.ok) {
        log(`slack proxy refused ${String(method)}: ${checked.error}`);
        return failure(checked.status, checked.error);
      }
      // method and channel only, never the content
      if (isAuditedMethod(checked.method)) log(`slack proxy ${checked.method} channel=${checked.params.channel ?? checked.params.channel_id ?? "-"}`);
      try {
        const res = await doFetch(`${SLACK_API}${checked.method}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${deps.botToken}`,
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          },
          body: new URLSearchParams(checked.params).toString(),
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
          const res = await doFetch(target, {
            headers: { Authorization: `Bearer ${deps.botToken}` },
            redirect: "manual",
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS * 4),
          });
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
            body: res.body,
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
