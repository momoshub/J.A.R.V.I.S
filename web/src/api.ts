/**
 * Tiny JSON API client. The dashboard is a local, loopback-only tool with no auth
 * token; requests just go to the same-origin `/api`.
 */
const headers = (): HeadersInit => ({ "content-type": "application/json" });

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

export type Bootstrap = {
  botName: string;
  ownerSlackId: string;
  model: string;
  commandPrefix: string;
  slashCommand: string;
};
export type Overview = {
  users: number;
  conversations: number;
  messages: number;
  learnings: number;
  /** True when memory is an adapter, so `learnings` counts memory items. */
  memory?: boolean;
};
export type UserRole = "owner" | "admin" | "executer" | "pal";
export type AllowedUser = {
  name?: string;
  slackId: string;
  role: UserRole;
  displayName: string;
  addedBy: string;
  createdAt: number;
};
export type Learning = { id: number; content: string; createdBy: string; createdAt: number };

/** The memory adapter as the dashboard renders it. Read-only: curating is `adapter refine`. */
export type AdapterView = {
  configured: boolean;
  status?: string;
  policy?: string;
  notes?: string;
  skills?: { name: string; description: string }[];
  people?: string[];
  channels?: string[];
  revisions?: { id: number; createdAt: number; createdBy: string; reason: string }[];
  items?: number;
};
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
  minRole: "owner" | "admin" | "executer" | "pal";
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
