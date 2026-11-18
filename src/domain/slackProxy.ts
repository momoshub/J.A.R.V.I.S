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
 * A new message in another channel is deliberately not allowed here, owner or not: the owner's
 * route is the `post` command (role gate + audit log), which the bot runs itself. The one
 * exception is `chat.update` in an owner's turn: it may edit a message the bot itself wrote
 * anywhere (a bad `post` has to be fixable from a DM). This file only lets the call through
 * marked `ownMessageIn`; the proxy then reads the message and refuses unless the bot wrote it.
 *
 * The built-in lists below are the floor: settings cannot remove from them. The owner may add more
 * (`slack-methods`), each a read or a channel-scoped write, and they reach this file as an argument
 * (`ExtraSlackMethods`), so the policy stays pure. An extra never overrides a built-in's kind.
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

/** One method the owner added beyond the built-in lists: a read, or a write with the parameter that names its channel. */
export type ExtraSlackMethod =
  | { readonly method: string; readonly kind: "read" }
  | { readonly method: string; readonly kind: "write"; readonly channelParam: string };

export type ExtraSlackMethods = readonly ExtraSlackMethod[];

/** `family.name`, one dot: that already leaves out the nested admin and tooling families. */
export const EXTRA_METHOD_NAME = /^[a-z]+\.[A-Za-z]+$/;

/** Families that hand out or change tokens, apps, installs and the workspace itself: never allowed, whatever the setting says. */
export const REFUSED_METHOD_FAMILIES: readonly string[] = ["auth", "admin", "apps", "oauth", "tooling", "openid"];

const PARAM_NAME = /^[a-z][a-z0-9_]{0,63}$/;

const isBuiltIn = (method: string): boolean => READ_METHODS.has(method) || Object.hasOwn(WRITE_METHODS, method);

/** Why this method cannot be added, or `undefined` when it can. */
export const refuseExtraMethod = (method: string): string | undefined => {
  if (!EXTRA_METHOD_NAME.test(method)) return `\`${method}\` is not a Slack method name (\`family.method\`, like \`conversations.setTopic\`)`;
  const family = method.slice(0, method.indexOf("."));
  if (REFUSED_METHOD_FAMILIES.includes(family)) return `\`${family}.*\` is never allowed: it touches tokens, apps or the workspace's admin`;
  if (isBuiltIn(method)) return `\`${method}\` is already built in`;
  return undefined;
};

/** Whether this is a valid write parameter name, for the one that names the channel. */
export const isChannelParam = (name: string): boolean => PARAM_NAME.test(name);

/** The stored value, as JSON. */
export const serializeExtraMethods = (methods: ExtraSlackMethods): string => (methods.length === 0 ? "" : JSON.stringify(methods));

/**
 * The stored value, read back. Never throws, and every entry is checked again: a hand-edited setting
 * naming `auth.test` or a write with no channel parameter is dropped, not trusted.
 */
export const parseExtraMethods = (raw: string | undefined): ExtraSlackMethods => {
  if (!raw?.trim()) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: ExtraSlackMethod[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const { method, kind, channelParam } = item as Record<string, unknown>;
    if (typeof method !== "string" || refuseExtraMethod(method) || out.some((m) => m.method === method)) continue;
    if (kind === "read") out.push({ method, kind });
    else if (kind === "write" && typeof channelParam === "string" && PARAM_NAME.test(channelParam)) out.push({ method, kind, channelParam });
  }
  return out;
};

/** Every method a turn may call right now, built-in then extra, as the prompt lists them. */
export const allowedMethodNames = (extra: ExtraSlackMethods = []): string[] => {
  const added = extra.filter((m) => !isBuiltIn(m.method));
  return [
    ...SLACK_PROXY_METHODS.read,
    ...added.filter((m) => m.kind === "read").map((m) => m.method),
    ...SLACK_PROXY_METHODS.write,
    ...added.filter((m) => m.kind === "write").map((m) => m.method),
  ];
};

/** What the ticket allows: the channel a write may target (none means read-only) and the thread the turn runs in. */
export type SlackScope = {
  readonly channel?: string;
  readonly threadTs?: string;
  /** The turn was started by the owner. Nobody else's turn may `chat.update` outside its channel. */
  readonly owner?: boolean;
};

/**
 * Writes that post a new message, with the parameter that places it in a thread.
 * A turn running in a thread that forgets it lands a top-level message instead.
 */
const THREADED_WRITES: Readonly<Record<string, string>> = {
  "chat.postMessage": "thread_ts",
  "files.completeUploadExternal": "thread_ts",
};

/** `thread_ts=none` asks for a deliberate top-level post; the proxy strips it, Slack never sees it. */
export const TOP_LEVEL_THREAD = "none";

export type SlackCallCheck =
  | {
      readonly ok: true;
      readonly method: string;
      readonly params: Readonly<Record<string, string>>;
      /** Set on an owner's `chat.update` outside the turn's channel: the proxy must first confirm the bot wrote this message. */
      readonly ownMessageIn?: { readonly channel: string; readonly ts: string };
    }
  | { readonly ok: false; readonly status: 400 | 403; readonly error: string };

/** One call carries no more than this, which keeps a runaway loop from posting a book. */
export const MAX_PARAMS_BYTES = 1_000_000;

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

/**
 * Is this message one of the bot's own approval notices (a learning, loop,
 * command approval, access request or cloudwatch request)? Answered from what
 * the bot stored when it posted them, so no Slack read is needed per call.
 */
export type IsNotice = (channel: string, ts: string) => boolean;

/** Decide whether this call may go to Slack. Never throws. */
export const checkSlackCall = (
  method: unknown,
  rawParams: unknown,
  scope: SlackScope,
  isNotice?: IsNotice,
  extra: ExtraSlackMethods = [],
): SlackCallCheck => {
  if (typeof method !== "string" || !METHOD_NAME.test(method)) return refuse(400, "method is required");
  // The built-ins decide first; an extra only matters for a method they do not know, and only if it still passes the name rules.
  const added = isBuiltIn(method) || refuseExtraMethod(method) ? undefined : extra.find((m) => m.method === method);
  const isRead = READ_METHODS.has(method) || added?.kind === "read";
  const isWrite = Object.hasOwn(WRITE_METHODS, method) || added?.kind === "write";
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
  const channelParam = added?.kind === "write" ? added.channelParam : WRITE_METHODS[method];
  const target = channelParam ? params[channelParam] : undefined;
  let ownMessageIn: { channel: string; ts: string } | undefined;
  if (channelParam && target !== scope.channel) {
    // Only the owner's chat.update, and only with a message named; whose message it is gets checked against Slack by the proxy.
    if (method !== "chat.update" || !scope.owner || !target || !params.ts) {
      return refuse(403, `channel_not_allowed: ${method} may only act in the channel this turn runs in (${scope.channel})`);
    }
    ownMessageIn = { channel: target, ts: params.ts };
  }
  // A notice's buttons decide things, and a notice can sit in a thread the turn runs in: a turn that could rewrite one
  // could relabel a button so the owner's click means something else. The turn's own messages stay editable.
  if (method === "chat.update" && params.ts && isNotice?.(params.channel ?? scope.channel, params.ts)) {
    return refuse(403, "message_not_allowed: chat.update may not rewrite an approval notice, only the turn's own messages");
  }
  // `channels` is the older way to share a file into several places at once.
  if (method === "files.completeUploadExternal" && params.channels !== undefined) {
    return refuse(403, "param_not_allowed: files.completeUploadExternal takes channel_id, never channels");
  }
  const threadParam = THREADED_WRITES[method];
  if (threadParam) {
    const given = params[threadParam]?.trim();
    if (given === TOP_LEVEL_THREAD) {
      const rest = { ...params };
      delete rest[threadParam];
      return { ok: true, method, params: rest };
    }
    // Not given (or blank) and the turn runs in a thread: the reply belongs there. An explicit thread_ts is kept as is.
    if (!given && scope.threadTs) return { ok: true, method, params: { ...params, [threadParam]: scope.threadTs } };
  }
  return { ok: true, method, params, ...(ownMessageIn ? { ownMessageIn } : {}) };
};

/** Calls worth a log line: everything that writes (extra writes too), and a join (visible to the whole channel). */
export const isAuditedMethod = (method: string, extra: ExtraSlackMethods = []): boolean =>
  Object.hasOwn(WRITE_METHODS, method) || method === "conversations.join" || extra.some((m) => m.method === method && m.kind === "write");

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
