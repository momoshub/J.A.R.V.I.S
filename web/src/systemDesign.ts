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
  { label: "turn started while a restart waits", value: 2 * 60_000, unit: "ms", source: "src/domain/selfUpdate.ts:RESTART_TURN_BUDGET_MS", why: "new messages still answered during a drain; past it the turn is cut and resumed after" },
  { label: "inbox delivery attempts", value: 4, unit: "count", source: "src/domain/inbox.ts:MAX_ATTEMPTS", why: "a message that crashes the bot every time must not become a crash loop" },
  { label: "retry delay after a second cut-off", value: 5 * 60_000, unit: "ms", source: "src/domain/inbox.ts:RETRY_DELAY_MS", why: "a repeat cut-off usually means something is still going on" },
  { label: "interactive ack wait", value: 2_500, unit: "ms", source: "src/domain/inbox.ts:ACK_WAIT_MS", why: "under Slack's 3s, so a modal's validation errors still arrive" },
  { label: "socket away before self-exit", value: 180_000, unit: "ms", source: "src/domain/connectionHealth.ts:CONNECTION_GRACE_MS", why: "a deaf socket looks alive; exiting lets launchd revive it" },
  { label: "offline notice lead", value: 600_000, unit: "ms", source: "src/domain/offlineAlarm.ts:OFFLINE_ALARM_LEAD_MS", why: "kept armed on Slack's side; Slack ignores a cancel within ~5 min of due" },
  { label: "stuck-work sweep", value: 15 * 60_000, unit: "ms", source: "src/domain/stuckWork.ts:SWEEP_TICK_MS", why: "dead Orca workers and quiet PRs DMed to the owner; one item at most every 4h" },
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
  { name: "allowed_users", db: "bot.db", note: "who may talk to it, and as what", col: 2, row: 0,
    cols: [{ name: "slack_id", key: "pk" }, { name: "role" }, { name: "display_name" }, { name: "added_by" }] },
  { name: "settings", db: "bot.db", note: "identity and switches, as data", col: 0, row: 0,
    cols: [{ name: "key", key: "pk" }, { name: "value" }] },
  { name: "adapter_files", db: "bot.db", note: "memory: policy, notes, skills", col: 0, row: 1,
    cols: [{ name: "path", key: "pk" }, { name: "content" }] },
  { name: "adapter_revisions", db: "bot.db", note: "a whole snapshot per change", col: 0, row: 2,
    cols: [{ name: "id", key: "pk" }, { name: "reason" }, { name: "created_by" }, { name: "files" }] },
  { name: "messages", db: "bot.db", note: "stored turns per thread", col: 1, row: 0,
    cols: [{ name: "id", key: "pk" }, { name: "channel_id", key: "ref" }, { name: "thread_ts", key: "ref" }, { name: "slack_user_id", key: "ref" }, { name: "role" }, { name: "content" }] },
  { name: "thread_sessions", db: "bot.db", note: "one CLI session per thread and tier", col: 1, row: 1,
    cols: [{ name: "channel_id", key: "pk" }, { name: "thread_ts", key: "pk" }, { name: "tier", key: "pk" }, { name: "session_id" }, { name: "prompt_hash" }] },
  { name: "workflows", db: "bot.db", note: "long tasks on a durable session", col: 1, row: 2,
    cols: [{ name: "id", key: "pk" }, { name: "channel_id", key: "ref" }, { name: "thread_ts", key: "ref" }, { name: "session_id" }, { name: "status" }, { name: "steers" }] },
  { name: "watches", db: "bot.db", note: "a shell check polled outside any turn", col: 1, row: 3,
    cols: [{ name: "id", key: "pk" }, { name: "channel_id", key: "ref" }, { name: "thread_ts", key: "ref" }, { name: "check_cmd" }, { name: "next_at" }, { name: "state" }] },
  { name: "llm_usage", db: "bot.db", note: "what every run cost", col: 2, row: 1,
    cols: [{ name: "id", key: "pk" }, { name: "slack_user_id", key: "ref" }, { name: "kind" }, { name: "model" }, { name: "cost_usd" }, { name: "duration_ms" }] },
  { name: "turn_log", db: "bot.db", note: "how each turn ended", col: 2, row: 2,
    cols: [{ name: "id", key: "pk" }, { name: "channel_id", key: "ref" }, { name: "thread_ts", key: "ref" }, { name: "slack_user_id", key: "ref" }, { name: "outcome" }, { name: "error" }] },
  { name: "command_log", db: "bot.db", note: "the audit log", col: 2, row: 3,
    cols: [{ name: "id", key: "pk" }, { name: "slack_user_id", key: "ref" }, { name: "command" }, { name: "args" }, { name: "ok" }] },
  { name: "reminders", db: "bot.db", note: "a time and a line, no model", col: 3, row: 1,
    cols: [{ name: "id", key: "pk" }, { name: "channel_id", key: "ref" }, { name: "thread_ts", key: "ref" }, { name: "due_at" }, { name: "state" }] },
  { name: "inbox", db: "inbox.db", note: "every Slack envelope", col: 3, row: 0,
    cols: [{ name: "id", key: "pk" }, { name: "dedupe_key" }, { name: "type" }, { name: "state" }, { name: "attempts" }, { name: "acked_at" }] },
  { name: "role_policies", db: "bot.db", note: "per role: on/off and what it is denied", col: 3, row: 2,
    cols: [{ name: "role", key: "pk" }, { name: "enabled" }, { name: "denied_commands" }, { name: "denied_tools" }, { name: "denied_mcp_servers" }] },
  { name: "github_app_deliveries", db: "bot.db", note: "the GitHub App's dedupe and queue", col: 0, row: 3,
    cols: [{ name: "id", key: "pk" }, { name: "trigger" }, { name: "state" }, { name: "slack_channel" }, { name: "slack_ts" }] },
  { name: "orca_questions", db: "bot.db", note: "Orca worker questions put to their thread, once", col: 1, row: 4,
    cols: [{ name: "message_id", key: "pk" }, { name: "run_id" }, { name: "dispatch_id" }, { name: "channel_id", key: "ref" }, { name: "thread_ts", key: "ref" }, { name: "state" }] },
];

export const RELATIONS: Relation[] = [
  { from: "messages", to: "allowed_users", on: "slack_user_id" },
  { from: "llm_usage", to: "allowed_users", on: "slack_user_id" },
  { from: "command_log", to: "allowed_users", on: "slack_user_id" },
  { from: "role_policies", to: "allowed_users", on: "role" },
  { from: "thread_sessions", to: "messages", on: "channel_id, thread_ts" },
  { from: "workflows", to: "messages", on: "channel_id, thread_ts (own durable session_id, not a thread_sessions row)" },
  { from: "watches", to: "messages", on: "channel_id, thread_ts" },
  { from: "turn_log", to: "messages", on: "channel_id, thread_ts" },
  { from: "orca_questions", to: "messages", on: "channel_id, thread_ts (the thread that started the worker, via orca_threads)" },
  { from: "adapter_revisions", to: "adapter_files", on: "snapshot of every row" },
];

/** Data-model layout: tables in a grid of columns, each column stacked top-down. */
export const ER = { colW: 250, gapX: 60, rowH: 26, headH: 46, gapY: 26, pad: 16 };
export const tableH = (t: Table) => ER.headH + t.cols.length * ER.rowH + 8;

type Pt = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };

export const erLayout = (tables: Table[] = TABLES) => {
  const pos = new Map<string, Box>();
  const colTop = new Map<number, number>();
  for (const t of [...tables].sort((a, b) => a.col - b.col || a.row - b.row)) {
    const y = colTop.get(t.col) ?? ER.pad;
    const h = tableH(t);
    pos.set(t.name, { x: ER.pad + t.col * (ER.colW + ER.gapX), y, w: ER.colW, h });
    colTop.set(t.col, y + h + ER.gapY);
  }
  const cols = Math.max(...tables.map((t) => t.col)) + 1;
  return { pos, w: ER.pad * 2 + cols * ER.colW + (cols - 1) * ER.gapX, h: Math.max(...colTop.values()) - ER.gapY + ER.pad };
};

/**
 * A join as a cubic curve between the two tables' header rows. Same column:
 * loop out on the right edge, each relation a little further out so loops do
 * not sit on each other. Otherwise leave from the facing sides.
 */
export const relationCurve = (a: Box, b: Box, lane = 0, ay = a.y + 22, by = b.y + 22): [Pt, Pt, Pt, Pt] => {
  if (a.x === b.x) {
    const x = a.x + a.w;
    const out = 22 + lane * 9;
    return [{ x, y: ay }, { x: x + out, y: ay }, { x: x + out, y: by }, { x, y: by }];
  }
  const ax = a.x < b.x ? a.x + a.w : a.x;
  const bx = a.x < b.x ? b.x : b.x + b.w;
  const mid = (ax + bx) / 2;
  return [{ x: ax, y: ay }, { x: mid, y: ay }, { x: mid, y: by }, { x: bx, y: by }];
};

/** The y of a column's row inside a drawn table, or the header when the table has no such column. */
const rowY = (t: Table | undefined, box: Box, col: string): number => {
  const i = t?.cols.findIndex((c) => c.name === col) ?? -1;
  return i < 0 ? box.y + 22 : box.y + ER.headH + 10 + i * ER.rowH;
};

export const cubicAt = ([p0, p1, p2, p3]: [Pt, Pt, Pt, Pt], t: number): Pt => {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
};

/**
 * Each relation's curve. A line leaves from the row of the column it joins on,
 * same-column loops get their own lane, and lines arriving at one table are
 * fanned a few pixels apart so no arrowhead lands on another line's start.
 */
export const erRelations = () => {
  const { pos } = erLayout();
  const byName = new Map(TABLES.map((t) => [t.name, t]));
  const lanes = new Map<number, number>();
  const arrivals = new Map<string, number>();
  return RELATIONS.flatMap((r) => {
    const a = pos.get(r.from);
    const b = pos.get(r.to);
    if (!a || !b) return [];
    let lane = 0;
    if (a.x === b.x) {
      lane = lanes.get(a.x) ?? 0;
      lanes.set(a.x, lane + 1);
    }
    const n = arrivals.get(r.to) ?? 0;
    arrivals.set(r.to, n + 1);
    const key = r.on.split(/[ ,]/)[0] ?? "";
    const ay = rowY(byName.get(r.from), a, key);
    const by = rowY(byName.get(r.to), b, key) + n * 6;
    return [{ rel: r, curve: relationCurve(a, b, lane, ay, by) }];
  });
};

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
    { id: "gw", label: "gateway agent", sub: "bun src/gateway.ts - not restarted on deploy", x: 40, y: 60, w: 260, h: 56, kind: "agent" },
    { id: "bot", label: "bot agent", sub: "bun src/index.ts - restarts on deploy", x: 40, y: 200, w: 260, h: 56, kind: "agent" },
    { id: "cli", label: "claude -p", sub: "one child process per turn", x: 40, y: 390, w: 260, h: 56, kind: "agent" },
    { id: "p2002", label: ":2001 loopback", sub: "DASHBOARD_PORT", x: 520, y: 190, w: 140, h: 46, kind: "port" },
    { id: "p2003", label: ":2003 loopback", sub: "GITHUB_APP_PORT", x: 520, y: 270, w: 140, h: 46, kind: "port" },
    { id: "inboxdb", label: "data/inbox.db", sub: "gitignored, WAL", x: 340, y: 106, w: 140, h: 46, kind: "file" },
    { id: "botdb", label: "data/<bot>.db", sub: "committed", x: 340, y: 300, w: 140, h: 46, kind: "file" },
    { id: "funnel", label: "Tailscale Funnel", sub: "https://<host>/github", x: 520, y: 350, w: 140, h: 56, kind: "agent" },
    { id: "slack", label: "Slack", sub: "WSS + Web API", x: 760, y: 60, w: 200, h: 56, kind: "external" },
    { id: "anthropic", label: "Anthropic", sub: "model API", x: 760, y: 430, w: 200, h: 56, kind: "external" },
    { id: "github", label: "GitHub", sub: "API + webhooks", x: 760, y: 250, w: 200, h: 56, kind: "external" },
  ],
  links: [
    { from: "gw", to: "slack", label: "Socket Mode" },
    { from: "gw", to: "inboxdb", label: "write" },
    { from: "bot", to: "inboxdb", label: "claim / ack / done" },
    { from: "bot", to: "slack", label: "Web API" },
    { from: "bot", to: "github", label: "API" },
    { from: "bot", to: "p2002", label: "dashboard + /api" },
    { from: "bot", to: "p2003", label: "webhook listener" },
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
