/**
 * What an agent turn may ask Slack for, through the bot.
 *
 * The turn does not hold the bot's Slack token. It calls a local helper that
 * presents its per-turn ticket to the bot, and the bot makes the call. That
 * only helps if the bot does not simply forward anything it is handed, so this
 * is the allowlist: a fixed set of Web API methods, and for the ones that write,
 * only into the channel the turn is running in.
 *
 * Reads are not channel-scoped: reading a linked thread elsewhere is the point
 * of them, and they cannot post, edit, delete, invite or set anything. Writes
 * are, because a prompt-injected turn that could post anywhere would be an
 * exfiltration channel of its own.
 *
 * Pure: no I/O, so the whole policy is testable without Slack.
 */

/** Methods that only read. `conversations.join` is here because reading a public channel the bot is not in needs it, and Slack refuses it for private ones. */
const READ_METHODS: ReadonlySet<string> = new Set([
  "conversations.history",
  "conversations.replies",
  "conversations.info",
  "conversations.list",
  "conversations.join",
  "users.info",
]);

/**
 * Methods that write, with the parameter that names the channel they act in.
 * `files.getUploadURLExternal` has none: it only reserves an upload URL, so it
 * is allowed whenever the ticket has a channel (the completion that makes the
 * file visible is channel-scoped).
 */
const WRITE_METHODS: Readonly<Record<string, string | undefined>> = {
  "chat.postMessage": "channel",
  "chat.update": "channel",
  "reactions.add": "channel",
  "files.getUploadURLExternal": undefined,
  "files.completeUploadExternal": "channel_id",
};

/** The methods this proxy will ever call, for help text and docs. */
export const SLACK_PROXY_METHODS = {
  read: [...READ_METHODS],
  write: Object.keys(WRITE_METHODS),
} as const;

/** What the ticket allows: the channel a write may target. None means read-only. */
export type SlackScope = { readonly channel?: string };

export type SlackCallCheck =
  | { readonly ok: true; readonly method: string; readonly params: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly status: 400 | 403; readonly error: string };

/** One call carries no more than this, which keeps a runaway loop from posting a book. */
export const MAX_PARAMS_BYTES = 1_000_000;

const PARAM_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const METHOD_NAME = /^[a-zA-Z][a-zA-Z0-9.]{0,63}$/;

const refuse = (status: 400 | 403, error: string): SlackCallCheck => ({ ok: false, status, error });

/** Strings, numbers and booleans become form values; anything else is not a Slack form parameter. */
const toParams = (raw: unknown): Record<string, string> | undefined => {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  let bytes = 0;
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
    const text = String(value);
    bytes += name.length + text.length;
    if (bytes > MAX_PARAMS_BYTES) return undefined;
    out[name] = text;
  }
  return out;
};

/** Decide whether this call may go to Slack. Never throws. */
export const checkSlackCall = (method: unknown, rawParams: unknown, scope: SlackScope): SlackCallCheck => {
  if (typeof method !== "string" || !METHOD_NAME.test(method)) return refuse(400, "method is required");
  const isRead = READ_METHODS.has(method);
  const isWrite = Object.hasOwn(WRITE_METHODS, method);
  if (!isRead && !isWrite) {
    return refuse(403, `method_not_allowed: ${method} is not one of the Slack methods a turn may call`);
  }
  const params = toParams(rawParams);
  if (!params) return refuse(400, "params must be an object of strings (blocks and files are JSON strings)");
  for (const name of Object.keys(params)) {
    if (!PARAM_NAME.test(name)) return refuse(400, `invalid parameter name: ${name}`);
    // The bot's own token is added on its side; a caller-supplied one is never wanted.
    if (name === "token") return refuse(403, "param_not_allowed: token");
  }
  if (isRead) {
    // The directory of public channels, not a listing of DMs and private groups.
    if (method === "conversations.list" && params.types !== undefined && params.types !== "public_channel") {
      return refuse(403, "param_not_allowed: conversations.list may only list public_channel");
    }
    return { ok: true, method, params };
  }
  if (!scope.channel) return refuse(403, `read_only_ticket: ${method} writes, and this ticket has no channel`);
  const channelParam = WRITE_METHODS[method];
  if (channelParam && params[channelParam] !== scope.channel) {
    return refuse(403, `channel_not_allowed: ${method} may only act in the channel this turn runs in (${scope.channel})`);
  }
  // `channels` is the older way to share a file into several places at once.
  if (method === "files.completeUploadExternal" && params.channels !== undefined) {
    return refuse(403, "param_not_allowed: files.completeUploadExternal takes channel_id, never channels");
  }
  return { ok: true, method, params };
};

/** Calls worth a log line: everything that writes, and a join (visible to the whole channel). */
export const isAuditedMethod = (method: string): boolean => Object.hasOwn(WRITE_METHODS, method) || method === "conversations.join";

/** Where Slack serves a private file from: files.slack.com, or a workspace's files-pri path. */
export const isSlackFileUrl = (raw: unknown): boolean => {
  if (typeof raw !== "string") return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  // `url_private` is always /files-pri/ (thumbnails are /files-tmb/); nothing else on the host gets the token.
  if (url.hostname === "files.slack.com") return url.pathname.startsWith("/files-pri/") || url.pathname.startsWith("/files-tmb/");
  return url.hostname.endsWith(".slack.com") && url.pathname.startsWith("/files-pri/");
};
