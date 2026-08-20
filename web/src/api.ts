/**
 * Tiny JSON API client. The dashboard token arrives once in the URL (`?token=`),
 * is stashed in sessionStorage so refreshes keep working, and is sent as the
 * `X-Dashboard-Token` header on every request (a custom header the browser will
 * not attach cross-origin, which doubles as CSRF protection).
 */
const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken) sessionStorage.setItem("ev_token", urlToken);
export const token = urlToken ?? sessionStorage.getItem("ev_token") ?? "";

const headers = (): HeadersInit => ({
  "X-Dashboard-Token": token,
  "content-type": "application/json",
});

export const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`/api/${path}`, { headers: headers() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `GET ${path} failed`);
  return res.json() as Promise<T>;
};

export const post = async <T = { ok: true }>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(`/api/${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `POST ${path} failed`);
  return json as T;
};

export type Bootstrap = { botName: string; ownerSlackId: string; model: string };
export type Overview = { users: number; conversations: number; messages: number; learnings: number };
export type UserRole = "owner" | "admin" | "member";
export type AllowedUser = {
  slackId: string;
  role: UserRole;
  displayName: string;
  addedBy: string;
  createdAt: number;
};
export type Learning = { id: number; content: string; createdBy: string; createdAt: number };
export type Identity = {
  name: string;
  thinkingLabel: string;
  thinkingDoneLabel: string;
  persona: string;
  usingDefault: boolean;
  defaultPersona: string;
};
export type Channel = { channelId: string; count: number; lastAt: number };
export type Message = {
  id: number;
  channelId: string;
  slackUserId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
};

export type SlackConversation = {
  id: string;
  name: string;
  kind: "channel" | "group" | "im" | "mpim";
  lastActive: number;
};
export type SlackMessage = {
  ts: string;
  userId: string;
  userName: string;
  text: string;
  replyCount: number;
  threadTs?: string;
  own: boolean;
  mentionsBot: boolean;
};

export type CommandInfo = {
  name: string;
  aliases: string[];
  minRole: "owner" | "admin" | "member";
  usage: string;
  summary: string;
};
export type CommandLogEntry = {
  id: number;
  slackUserId: string;
  command: string;
  args: string;
  channelId: string;
  ok: boolean;
  result: string;
  createdAt: number;
};

export const fmtTime = (ms: number): string =>
  ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : "-";

/** Slack timestamps are "seconds.micros" strings. */
export const fmtSlackTs = (ts: string): string => {
  const secs = Number(ts.split(".")[0]);
  return secs ? new Date(secs * 1000).toISOString().replace("T", " ").slice(5, 16) : "-";
};
