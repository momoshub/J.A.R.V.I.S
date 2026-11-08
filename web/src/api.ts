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
/** One line of a spend breakdown: a person, or a command. */
export type UsageSlice = {
  key: string;
  runs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  durationMs: number;
};
export type UsageView = {
  recording: boolean;
  windowMs?: number;
  totals: Omit<UsageSlice, "key">;
  byUser: UsageSlice[];
  byKind: UsageSlice[];
  /** Slack id -> display name, so a table is not a wall of U0ABC123. */
  names: Record<string, string>;
};
export type UserRole = "owner" | "admin" | "executer" | "pal";
export type AllowedUser = {
  name?: string;
  slackId: string;
  role: UserRole;
  displayName: string;
  addedBy: string;
  createdAt: number;
  /** GitHub logins linked to this person (the `github_login:` settings). */
  githubLogins: string[];
};

/** One role as the Roles page edits it. Denials only: a policy never grants past the code's ceilings. */
export type RoleView = {
  role: UserRole;
  enabled: boolean;
  /** The owner role: always on, never restricted, not editable. */
  locked: boolean;
  deniedCommands: string[];
  deniedTools: string[];
  deniedMcpServers: string[];
  members: { slackId: string; name: string }[];
  /** Commands within this role's rank - the ones there is anything to deny. */
  commands: string[];
};
export type RolesView = {
  roles: RoleView[];
  tools: string[];
  mcpServers: string[];
  editable: boolean;
  executerTools: string;
  palTools: string[];
};
export type Learning = { id: number; content: string; createdBy: string; createdAt: number };

/** The memory adapter as the dashboard renders it. Hand edits go through `adapter/file`. */
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
export type AdapterFile = { path: string; content: string };
export type Identity = {
  name: string;
  thinkingLabel: string;
  thinkingDoneLabel: string;
  persona: string;
  usingDefault: boolean;
  defaultPersona: string;
};
/** `label` is always name + id: `#team-chat (C0…)`, a DM as `@Person (D0…)`. */
export type Channel = { channelId: string; count: number; lastAt: number; label: string };
export type Message = {
  id: number;
  channelId: string;
  slackUserId: string;
  /** `Name (U0…)` - never a bare id. */
  userLabel: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
};
/** One page of a conversation, oldest-first; `nextBefore` fetches the page above it. */
export type ConversationView = {
  channel: { id: string; label: string };
  messages: Message[];
  total: number;
  nextBefore?: number;
};
/** One page of the conversation list; `nextCursor` fetches the next. */
export type ChannelPage = { channels: Channel[]; nextCursor?: string };

/** A workspace member from the Users page search. `role` is set when they are already on the list. */
export type SlackMember = {
  id: string;
  handle: string;
  realName: string;
  displayName: string;
  title: string;
  avatar: string;
  role?: UserRole;
};

export type StatsView =
  | { recording: false; error?: string }
  | {
      recording: true;
      days: number;
      messages: { date: string; user: number; assistant: number }[];
      turns: { date: string; ok: number; failed: number }[];
      spend: { date: string; runs: number; costUsd: number }[];
      topCommands: { key: string; runs: number; failed: number }[];
      topUsers: { key: string; label: string; turns: number; commands: number }[];
      activeThreads: { day: number; week: number; window: number };
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
  /** `Name (U0…)`. */
  userLabel: string;
  /** `#channel (C0…)`, or "" when it ran outside a conversation. */
  channelLabel: string;
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
