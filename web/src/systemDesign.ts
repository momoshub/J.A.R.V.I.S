/**
 * The static half of the architecture page, laid out the way a system design
 * interview goes: requirements, limits, data model, one request as a sequence,
 * where it runs, and what fails and how it recovers.
 *
 * Hand-kept like `systemModel.ts`, and checked the same way:
 * `tests/web/systemDesign.test.ts` fails when a table or column here is not in
 * the schema, or a limit no longer matches the constant it cites.
 */

export const REQUIREMENTS = {
  functional: [
    "Answer people in Slack threads, DMs and mentions, streaming the reply as it is written",
    "Run commands by name with a role gate, an allowance and an audit log",
    "Keep one model session per thread so context survives between turns",
    "Review pull requests, raise and close tickets, investigate logs, on request",
    "Wait for things (CI, a merge, a reply) and pick the thread back up by itself",
    "Be called from GitHub and answer there",
    "Fix itself: PR, standalone review, green CI, merge, restart",
  ],
  nonFunctional: [
    "Never lose a Slack message, across restarts and crashes",
    "One turn per thread at a time - no two answers racing in one session",
    "Least privilege per role, and no turn can act as someone else",
    "A restart waits for running turns, bounded, and never boots a red build",
    "Say so when offline, even though an offline host cannot post",
    "Cost is recorded per person and per command",
  ],
};

export type Limit = { label: string; value: number; unit: "chars" | "ms" | "count" | "bytes"; source: string; why: string };

/** `source` is `path:CONSTANT`; the test imports that constant and compares. */
export const LIMITS: Limit[] = [
  { label: "streamed message rollover", value: 11_000, unit: "chars", source: "src/infrastructure/slack/stream.ts:STREAM_CHAR_BUDGET", why: "Slack drops a streamed message at ~12k; roll over before, not after" },
  { label: "restart drain, at most", value: 15 * 60_000, unit: "ms", source: "src/domain/selfUpdate.ts:RESTART_MAX_WAIT_MS", why: "wait for running turns, then exit anyway; cut rows are redelivered" },
  { label: "inbox delivery attempts", value: 4, unit: "count", source: "src/domain/inbox.ts:MAX_ATTEMPTS", why: "a message that crashes the bot every time must not become a crash loop" },
  { label: "retry delay after a second cut-off", value: 5 * 60_000, unit: "ms", source: "src/domain/inbox.ts:RETRY_DELAY_MS", why: "a repeat cut-off usually means something is still going on" },
  { label: "interactive ack wait", value: 2_500, unit: "ms", source: "src/domain/inbox.ts:ACK_WAIT_MS", why: "under Slack's 3s, so a modal's validation errors still arrive" },
  { label: "socket away before self-exit", value: 180_000, unit: "ms", source: "src/domain/connectionHealth.ts:CONNECTION_GRACE_MS", why: "a deaf socket looks alive; exiting lets launchd revive it" },
  { label: "offline notice lead", value: 600_000, unit: "ms", source: "src/domain/offlineAlarm.ts:OFFLINE_ALARM_LEAD_MS", why: "kept armed on Slack's side; Slack ignores a cancel within ~5 min of due" },
  { label: "fastest watch poll", value: 15_000, unit: "ms", source: "src/domain/watch.ts:MIN_EVERY_MS", why: "a watch is a shell command on a timer" },
  { label: "longest watch", value: 6 * 60 * 60_000, unit: "ms", source: "src/domain/watch.ts:MAX_DEADLINE_MS", why: "a watch nobody ends is a leak with a timer" },
  { label: "always-on memory budget", value: 8_000, unit: "bytes", source: "src/domain/adapterCheck.ts:ALWAYS_ON_BUDGET", why: "what loads into every prompt; refine must get under it" },
  { label: "cold-session context window", value: 20, unit: "count", source: "src/domain/conversation.ts:DEFAULT_CONTEXT_WINDOW", why: "turns replayed when a session reopens cold" },
  { label: "workflow steps without a human", value: 30, unit: "count", source: "src/domain/workflowContinue.ts:AUTO_CONTINUE_CAP", why: "auto-continue pauses and asks after this many" },
  { label: "review sub-agents", value: 3, unit: "count", source: "src/domain/reviewPrompt.ts:DEFAULT_REVIEW_AGENTS", why: "default fan-out for a big PR, configurable 1-8" },
];

export const fmtLimit = (l: Limit): string => {
  if (l.unit === "ms") {
    const s = l.value / 1000;
    if (s < 60) return `${s}s`;
    const m = s / 60;
    return m < 60 ? `${m} min` : `${m / 60} h`;
  }
  if (l.unit === "chars") return `${l.value.toLocaleString("en")} chars`;
  if (l.unit === "bytes") return `${l.value.toLocaleString("en")} B`;
  return String(l.value);
};

export type Column = { name: string; key?: "pk" | "ref" };
export type Table = { name: string; db: "bot.db" | "inbox.db"; note: string; cols: Column[]; col: number; row: number };

/** A logical link: SQLite here has no foreign keys, rows meet on shared keys. */
export type Relation = { from: string; to: string; on: string };

export const TABLES: Table[] = [
  { name: "allowed_users", db: "bot.db", note: "who may talk to it, and as what", col: 0, row: 0,
    cols: [{ name: "slack_id", key: "pk" }, { name: "role" }, { name: "display_name" }, { name: "added_by" }] },
  { name: "settings", db: "bot.db", note: "identity and switches, as data", col: 0, row: 1,
    cols: [{ name: "key", key: "pk" }, { name: "value" }] },
  { name: "adapter_files", db: "bot.db", note: "memory: policy, notes, skills", col: 0, row: 2,
    cols: [{ name: "path", key: "pk" }, { name: "content" }] },
  { name: "adapter_revisions", db: "bot.db", note: "a whole snapshot per change", col: 0, row: 3,
    cols: [{ name: "id", key: "pk" }, { name: "reason" }, { name: "created_by" }, { name: "files" }] },
  { name: "messages", db: "bot.db", note: "stored turns per thread", col: 1, row: 0,
    cols: [{ name: "id", key: "pk" }, { name: "channel_id", key: "ref" }, { name: "thread_ts", key: "ref" }, { name: "slack_user_id", key: "ref" }, { name: "role" }, { name: "content" }] },
  { name: "thread_sessions", db: "bot.db", note: "one CLI session per thread and tier", col: 1, row: 1,
    cols: [{ name: "channel_id", key: "pk" }, { name: "thread_ts", key: "pk" }, { name: "tier", key: "pk" }, { name: "session_id" }, { name: "prompt_hash" }] },
  { name: "workflows", db: "bot.db", note: "long tasks on a durable session", col: 1, row: 2,
    cols: [{ name: "id", key: "pk" }, { name: "channel_id", key: "ref" }, { name: "thread_ts", key: "ref" }, { name: "session_id" }, { name: "status" }, { name: "steers" }] },
  { name: "watches", db: "bot.db", note: "a shell check polled outside any turn", col: 1, row: 3,
    cols: [{ name: "id", key: "pk" }, { name: "channel_id", key: "ref" }, { name: "thread_ts", key: "ref" }, { name: "check_cmd" }, { name: "next_at" }, { name: "state" }] },
  { name: "llm_usage", db: "bot.db", note: "what every run cost", col: 2, row: 0,
    cols: [{ name: "id", key: "pk" }, { name: "slack_user_id", key: "ref" }, { name: "kind" }, { name: "model" }, { name: "cost_usd" }, { name: "duration_ms" }] },
  { name: "turn_log", db: "bot.db", note: "how each turn ended", col: 2, row: 1,
    cols: [{ name: "id", key: "pk" }, { name: "channel_id", key: "ref" }, { name: "thread_ts", key: "ref" }, { name: "slack_user_id", key: "ref" }, { name: "outcome" }, { name: "error" }] },
  { name: "command_log", db: "bot.db", note: "the audit log", col: 2, row: 2,
    cols: [{ name: "id", key: "pk" }, { name: "slack_user_id", key: "ref" }, { name: "command" }, { name: "args" }, { name: "ok" }] },
  { name: "reminders", db: "bot.db", note: "a time and a line, no model", col: 2, row: 3,
    cols: [{ name: "id", key: "pk" }, { name: "channel_id", key: "ref" }, { name: "thread_ts", key: "ref" }, { name: "due_at" }, { name: "state" }] },
  { name: "inbox", db: "inbox.db", note: "every Slack envelope", col: 3, row: 0,
    cols: [{ name: "id", key: "pk" }, { name: "dedupe_key" }, { name: "type" }, { name: "state" }, { name: "attempts" }, { name: "acked_at" }] },
  { name: "github_app_deliveries", db: "bot.db", note: "the GitHub App's dedupe and queue", col: 3, row: 1,
    cols: [{ name: "id", key: "pk" }, { name: "trigger" }, { name: "state" }, { name: "slack_channel" }, { name: "slack_ts" }] },
];

export const RELATIONS: Relation[] = [
  { from: "messages", to: "allowed_users", on: "slack_user_id" },
  { from: "llm_usage", to: "allowed_users", on: "slack_user_id" },
  { from: "command_log", to: "allowed_users", on: "slack_user_id" },
  { from: "thread_sessions", to: "messages", on: "channel_id, thread_ts" },
  { from: "workflows", to: "thread_sessions", on: "channel_id, thread_ts" },
  { from: "watches", to: "messages", on: "channel_id, thread_ts" },
  { from: "turn_log", to: "messages", on: "channel_id, thread_ts" },
  { from: "adapter_revisions", to: "adapter_files", on: "snapshot of every row" },
];

export type Participant = { id: string; label: string; sub: string };
export type SeqMessage = { from: string; to: string; label: string; kind: "call" | "reply" | "async" };

/** The everyday path as a sequence diagram. A message to itself is drawn as a loop on its lifeline. */
export const SEQUENCE: { title: string; participants: Participant[]; messages: SeqMessage[] } = {
  title: "Someone mentions the bot",
  participants: [
    { id: "slack", label: "Slack", sub: "Socket Mode" },
    { id: "gateway", label: "gateway", sub: "own process" },
    { id: "inbox", label: "inbox.db", sub: "SQLite" },
    { id: "bot", label: "bot", sub: "respond + queue" },
    { id: "cli", label: "claude CLI", sub: "thread session" },
    { id: "model", label: "Claude", sub: "model" },
  ],
  messages: [
    { from: "slack", to: "gateway", label: "app_mention envelope", kind: "async" },
    { from: "gateway", to: "inbox", label: "insert row (dedupe on event_id)", kind: "call" },
    { from: "gateway", to: "slack", label: "ack - only after the row is stored", kind: "reply" },
    { from: "bot", to: "inbox", label: "claim pending row", kind: "call" },
    { from: "bot", to: "bot", label: "role check, enqueue behind the thread's turn", kind: "call" },
    { from: "bot", to: "cli", label: "spawn --resume <thread session>, role tool policy", kind: "call" },
    { from: "cli", to: "model", label: "inference, tool calls, inference", kind: "call" },
    { from: "cli", to: "bot", label: "stream-json: text, tool cards, usage", kind: "reply" },
    { from: "bot", to: "slack", label: "chat.startStream / append / stop", kind: "async" },
    { from: "bot", to: "inbox", label: "row done", kind: "call" },
  ],
};

export type DeployBox = { id: string; label: string; sub: string; x: number; y: number; w: number; h: number; kind: "zone" | "agent" | "port" | "file" | "external" };
export type DeployLink = { from: string; to: string; label: string };

/** Where it runs: one Mac, two launchd agents, loopback ports, files, and the services outside. */
export const DEPLOY: { w: number; h: number; boxes: DeployBox[]; links: DeployLink[] } = {
  w: 1000,
  h: 520,
  boxes: [
    { id: "host", label: "host Mac", sub: "launchd, KeepAlive", x: 20, y: 20, w: 660, h: 480, kind: "zone" },
    { id: "gw", label: "gateway agent", sub: "bun src/gateway.ts - never restarts", x: 40, y: 60, w: 260, h: 56, kind: "agent" },
    { id: "bot", label: "bot agent", sub: "bun src/index.ts - restarts on deploy", x: 40, y: 200, w: 260, h: 56, kind: "agent" },
    { id: "cli", label: "claude -p", sub: "one child process per turn", x: 40, y: 390, w: 260, h: 56, kind: "agent" },
    { id: "p2002", label: ":2002 loopback", sub: "dashboard + /api", x: 520, y: 190, w: 140, h: 46, kind: "port" },
    { id: "p2003", label: ":2003 loopback", sub: "GitHub webhook", x: 520, y: 270, w: 140, h: 46, kind: "port" },
    { id: "inboxdb", label: "data/inbox.db", sub: "gitignored, WAL", x: 340, y: 128, w: 140, h: 46, kind: "file" },
    { id: "botdb", label: "data/<bot>.db", sub: "committed", x: 340, y: 300, w: 140, h: 46, kind: "file" },
    { id: "funnel", label: "Tailscale Funnel", sub: "https://<host>/github", x: 520, y: 350, w: 140, h: 56, kind: "agent" },
    { id: "slack", label: "Slack", sub: "WSS + Web API", x: 760, y: 60, w: 200, h: 56, kind: "external" },
    { id: "anthropic", label: "Anthropic", sub: "model API", x: 760, y: 430, w: 200, h: 56, kind: "external" },
    { id: "github", label: "GitHub", sub: "API + webhooks", x: 760, y: 250, w: 200, h: 56, kind: "external" },
  ],
  links: [
    { from: "gw", to: "slack", label: "Socket Mode" },
    { from: "gw", to: "inboxdb", label: "write" },
    { from: "bot", to: "inboxdb", label: "read" },
    { from: "bot", to: "p2002", label: "serves" },
    { from: "bot", to: "p2003", label: "listens" },
    { from: "bot", to: "botdb", label: "" },
    { from: "bot", to: "cli", label: "spawn" },
    { from: "cli", to: "anthropic", label: "" },
    { from: "funnel", to: "p2003", label: "" },
    { from: "github", to: "funnel", label: "webhook" },
  ],
};

export const FAILURES: { failure: string; detect: string; recover: string }[] = [
  { failure: "Bot restarts or crashes", detect: "rows left pending or running in inbox.db", recover: "the gateway kept the socket and queued; the next process claims the rows, cut ones first" },
  { failure: "Socket goes deaf", detect: "away longer than the grace period", recover: "the gateway exits itself and launchd revives it; /health returns 503 meanwhile" },
  { failure: "Host loses the network", detect: "nothing - it cannot post", recover: "a notice already scheduled on Slack's side posts itself, and is edited to 'back online' later" },
  { failure: "Reply cut mid-stream", detect: "the row records every message it opened", recover: "stop the stream, mark it interrupted, retry told to continue rather than repeat" },
  { failure: "Turn runs away", detect: "turn timeout or a stop press", recover: "the whole process tree is killed, SIGKILL after a grace period" },
  { failure: "Same event delivered twice", detect: "dedupe key: Slack event_id, GitHub delivery id", recover: "the second copy is dropped" },
  { failure: "Self-fix breaks the build", detect: "typecheck and tests in the restart helper, CI on the PR", recover: "no merge on red, no restart on red" },
];
