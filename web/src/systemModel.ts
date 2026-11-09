/**
 * The system as data: the boxes on the architecture diagram, the wires between
 * them, and the request flows that walk those wires step by step.
 *
 * Hand-kept from ARCHITECTURE.md. Change it in the same PR as the code it
 * describes - `checkModel` refuses a flow that names a box or wire that is not
 * here, so a rename cannot leave a flow pointing at nothing.
 */

export type NodeKind = "external" | "process" | "module" | "store" | "timer";

export type SysNode = {
  id: string;
  label: string;
  sub: string;
  kind: NodeKind;
  /** Centre on the 1100 x 640 canvas. */
  x: number;
  y: number;
  /** What it is for, one or two sentences. */
  about: string;
  files: string[];
};

/** `bend` pushes the curve sideways (px, sign picks the side) to route round a box. */
export type SysEdge = { from: string; to: string; label: string; bend?: number };

/** A step either travels a wire or highlights one box. */
export type FlowStep =
  | { from: string; to: string; note: string }
  | { at: string; note: string };

export type Flow = { id: string; title: string; blurb: string; steps: FlowStep[] };

export const CANVAS = { w: 1100, h: 640 };
export const NODE = { w: 150, h: 50 };

export const NODES: SysNode[] = [
  { id: "slack", label: "Slack", sub: "Socket Mode + Web API", kind: "external", x: 100, y: 70,
    about: "Where people talk to the bot. Events arrive over one socket, replies leave over the Web API as a live stream.",
    files: [] },
  { id: "gateway", label: "gateway", sub: "src/gateway.ts", kind: "process", x: 100, y: 200,
    about: "Holds the Slack socket and nothing else. It never restarts, so restarting the bot never drops Slack.",
    files: ["src/gateway.ts", "src/infrastructure/slack/gateway.ts"] },
  { id: "inbox", label: "inbox.db", sub: "SQLite queue", kind: "store", x: 100, y: 330,
    about: "Every envelope becomes a row. The bot reads rows, so a message sent during a restart waits here instead of being lost.",
    files: ["src/infrastructure/inbox/inboxRepo.ts"] },
  { id: "receiver", label: "inboxReceiver", sub: "Bolt receiver + app.ts", kind: "module", x: 290, y: 330,
    about: "A Bolt receiver that reads the inbox instead of a socket, so every Bolt listener runs exactly as it would live.",
    files: ["src/infrastructure/slack/inboxReceiver.ts", "src/infrastructure/slack/app.ts"] },
  { id: "respond", label: "respond", sub: "route: command or chat", kind: "module", x: 470, y: 330,
    about: "Decides what a message is. A command prefix goes to the registry, anything else is a chat turn.",
    files: ["src/application/respond.ts"] },
  { id: "commands", label: "commands", sub: "role gate, allowance, audit", kind: "module", x: 650, y: 230,
    about: "The command registry. Every run checks the caller's role, spends an allowance and lands in the audit log.",
    files: ["src/application/commands.ts", "src/application/commands/shared.ts", "src/application/commandLimits.ts", "src/application/brainRun.ts"] },
  { id: "chat", label: "handleMessage", sub: "access, remember, ask", kind: "module", x: 830, y: 430,
    about: "The chat flow: check access, store the turn, ask the model with the role's tool policy, store the answer.",
    files: ["src/application/handleMessage.ts", "src/domain/toolPolicy.ts"] },
  { id: "queue", label: "threadQueue", sub: "1 turn per thread", kind: "module", x: 650, y: 430,
    about: "Serialises turns per thread so two messages never race in one session. runRegistry keeps a handle to stop one.",
    files: ["src/application/threadQueue.ts", "src/application/runRegistry.ts"] },
  { id: "llm", label: "claude CLI", sub: "--resume per thread", kind: "process", x: 1000, y: 330,
    about: "The brain. One CLI session per thread, resumed every turn, sandboxed by role: allowed tools, cwd, timeout.",
    files: ["src/infrastructure/llm/claudeCli.ts", "src/domain/threadSession.ts"] },
  { id: "model", label: "Claude", sub: "Anthropic model", kind: "external", x: 1000, y: 70,
    about: "The model behind the CLI. Usage and list price of every run are recorded for the Spend page.",
    files: [] },
  { id: "stream", label: "stream", sub: "chat.startStream", kind: "module", x: 830, y: 150,
    about: "Pipes model text and tool cards onto a live Slack message, falling back to a single post.",
    files: ["src/infrastructure/slack/stream.ts", "src/infrastructure/slack/fences.ts"] },
  { id: "tools", label: "bin/ helpers", sub: "slack-read, jarvis-run, ...", kind: "module", x: 1000, y: 560,
    about: "Shell helpers the brain calls from Bash. The ones that act go through the API with a one-turn ticket, never a raw token.",
    files: ["bin/"] },
  { id: "api", label: "dashboard API", sub: "Bun.serve, loopback", kind: "process", x: 830, y: 330,
    about: "This dashboard, plus /api/commands/run and /api/github-app/comment for the brain. Loopback only.",
    files: ["src/infrastructure/dashboard/server.ts", "src/application/dashboard.ts", "src/application/commandTickets.ts", "src/application/nameResolver.ts", "src/application/slackDirectory.ts", "src/infrastructure/db/statsRepo.ts"] },
  { id: "db", label: "bot.db", sub: "users, turns, memory", kind: "store", x: 100, y: 560,
    about: "SQLite: allowlist and roles, stored turns, sessions, watches, reminders, usage, the memory adapter.",
    files: ["src/infrastructure/db/", "src/infrastructure/adapter/adapterStore.ts"] },
  { id: "timers", label: "timers", sub: "watch, remind, reviews", kind: "timer", x: 470, y: 560,
    about: "Work outside any turn: watches, reminders, the review inbox poll, the Orca question bridge, workflow continues, the offline alarm, the stuck-work sweep (dead Orca workers and quiet PRs, DMed to the owner). None holds a session while it waits.",
    files: ["src/application/watcher.ts", "src/application/reminders.ts", "src/application/reviewInbox.ts", "src/application/orcaQuestions.ts", "src/application/offlineAlarm.ts", "src/application/stuckSweeper.ts"] },
  { id: "github", label: "GitHub", sub: "PRs, issues, Actions", kind: "external", x: 470, y: 70,
    about: "Review requests are polled once a minute by the timers. Mentions of the GitHub App arrive as webhooks through Tailscale Funnel.",
    files: [] },
  { id: "ghapp", label: "GitHub App", sub: "webhook :2003", kind: "process", x: 470, y: 200,
    about: "Verifies the signature, answers 202 at once, keeps only real calls as rows keyed by delivery id - the dedupe and the queue.",
    files: ["src/infrastructure/github/webhookServer.ts", "src/application/githubApp.ts"] },
];

export const EDGES: SysEdge[] = [
  { from: "slack", to: "gateway", label: "envelope" },
  { from: "gateway", to: "inbox", label: "insert row" },
  { from: "inbox", to: "receiver", label: "poll" },
  { from: "receiver", to: "respond", label: "listener" },
  { from: "respond", to: "db", label: "role lookup" },
  { from: "respond", to: "commands", label: "<prefix> cmd" },
  { from: "respond", to: "queue", label: "enqueue" },
  { from: "queue", to: "chat", label: "run turn" },
  { from: "chat", to: "llm", label: "ask model" },
  { from: "llm", to: "model", label: "inference" },
  { from: "llm", to: "stream", label: "tokens" },
  { from: "stream", to: "slack", label: "live reply", bend: -10 },
  { from: "llm", to: "tools", label: "Bash" },
  { from: "tools", to: "api", label: "ticketed call", bend: 70 },
  { from: "api", to: "commands", label: "run as caller" },
  { from: "commands", to: "stream", label: "output" },
  { from: "api", to: "github", label: "app comment", bend: 130 },
  { from: "github", to: "ghapp", label: "webhook" },
  { from: "ghapp", to: "respond", label: "turn as person" },
  { from: "timers", to: "commands", label: "review as requester", bend: 0 },
  { from: "commands", to: "llm", label: "preset task", bend: -110 },
  { from: "timers", to: "queue", label: "fresh turn" },
];

export const FLOWS: Flow[] = [
  {
    id: "mention",
    title: "Someone mentions the bot",
    blurb: "The everyday path, from a Slack message to a streamed answer.",
    steps: [
      { from: "slack", to: "gateway", note: "Slack pushes the event down the socket the gateway holds." },
      { from: "gateway", to: "inbox", note: "The gateway writes the envelope as a row, then acks Slack. That is all it does." },
      { from: "inbox", to: "receiver", note: "The bot polls the inbox. Bolt sees an ordinary event." },
      { from: "receiver", to: "respond", note: "The listener hands the message to respond." },
      { from: "respond", to: "db", note: "Who is this? The allowlist gives a role, the role gives a tool policy." },
      { from: "respond", to: "queue", note: "No command prefix, so it is a chat turn, queued behind any turn already running in this thread." },
      { from: "queue", to: "chat", note: "Its turn comes: check access, store the message." },
      { from: "chat", to: "llm", note: "The thread's CLI session is resumed with the role's tool policy, so the model keeps its context and files." },
      { from: "llm", to: "model", note: "The model thinks, calls tools, thinks again." },
      { from: "llm", to: "stream", note: "Text and tool cards stream out as they are produced." },
      { from: "stream", to: "slack", note: "One live Slack message grows into the answer." },
    ],
  },
  {
    id: "typed",
    title: "Someone types a command",
    blurb: "<prefix> <command> skips the model entirely - no session, no queue, no tokens unless the command spends them.",
    steps: [
      { from: "slack", to: "gateway", note: "Same door as every message." },
      { from: "gateway", to: "inbox", note: "Stored before it is acked, so an ack always means we have it." },
      { from: "inbox", to: "receiver", note: "Read by the bot like any other event." },
      { from: "receiver", to: "respond", note: "The listener hands it over." },
      { from: "respond", to: "db", note: "The caller's role decides which commands exist for them." },
      { from: "respond", to: "commands", note: "The prefix matched, so the registry takes it. Commands are not queued behind a running turn." },
      { at: "commands", note: "A near miss names the closest command the caller may run, instead of 'unknown'." },
      { from: "commands", to: "stream", note: "The output goes back into the thread." },
      { from: "stream", to: "slack", note: "Answered without waking the model." },
    ],
  },
  {
    id: "command",
    title: "The brain runs a command",
    blurb: "A turn asks for a real command instead of doing it by hand, and cannot escalate.",
    steps: [
      { from: "llm", to: "tools", note: "The model calls bin/jarvis-run.sh from Bash." },
      { from: "tools", to: "api", note: "The helper sends the turn's one-time ticket. It never names who is asking." },
      { from: "api", to: "commands", note: "The ticket is bound to the person being answered, so the command runs with their role." },
      { at: "commands", note: "Role gate, allowance and audit log - the parts a hand-rolled version would skip." },
      { from: "commands", to: "stream", note: "Posted output goes to the thread; quiet output comes back to the brain." },
      { from: "stream", to: "slack", note: "The thread sees the result." },
    ],
  },
  {
    id: "github-app",
    title: "Called from GitHub",
    blurb: "An @mention of the GitHub App in a PR becomes a Slack thread and an answer on GitHub.",
    steps: [
      { from: "github", to: "ghapp", note: "Webhook through Tailscale Funnel. Signature checked in constant time, 202 at once." },
      { at: "ghapp", note: "Kept only if it is a real call, from a human, in an allowed owner's repo. The delivery id is the dedupe." },
      { from: "ghapp", to: "respond", note: "Mapped to a Slack person and run as an ordinary turn in a new thread." },
      { from: "respond", to: "queue", note: "One turn per thread, as always." },
      { from: "queue", to: "chat", note: "Their role, their token." },
      { from: "chat", to: "llm", note: "The brain does the work." },
      { from: "llm", to: "tools", note: "It answers through bin/github-app-comment.sh (an admin's turn may also act as the app through bin/github-app.sh)." },
      { from: "tools", to: "api", note: "The ticket is bound to that one issue - it can answer this call and nothing else." },
      { from: "api", to: "github", note: "Posted as the app itself. The private key never reaches a turn." },
    ],
  },
  {
    id: "review",
    title: "A review request, polled",
    blurb: "No public address, so review requests are pulled, not pushed - and run as the review command, not a chat turn.",
    steps: [
      { at: "timers", note: "Once a minute it asks GitHub which PRs want the bot's account to review. A cursor per request, so a re-request counts again and a crash never posts twice." },
      { from: "timers", to: "commands", note: "It runs the review command as whoever asked, approve-after, posted in the review inbox thread." },
      { at: "commands", note: "Commands are not queued: no wait behind a running turn, and no thread session to resume." },
      { from: "commands", to: "llm", note: "A preset full-access brain on the requester's own token - none on file, no review." },
      { from: "commands", to: "stream", note: "The verdict lands in the thread, and on the PR." },
      { from: "stream", to: "slack", note: "Done, with nobody pinging anybody." },
    ],
  },
  {
    id: "watch",
    title: "A watch comes good",
    blurb: "A turn cannot wait, so the waiting is a stored predicate polled outside any turn.",
    steps: [
      { at: "timers", note: "A shell check polled on a timer. No model, no tokens, no queue slot, the thread stays live." },
      { from: "timers", to: "queue", note: "It exits 0: the thread gets a fresh turn as whoever set the watch, carrying their note." },
      { from: "queue", to: "chat", note: "An ordinary turn, so it gets a command ticket like any other." },
      { from: "chat", to: "llm", note: "Told to finish the job it agreed to, not hand it back." },
      { from: "llm", to: "stream", note: "The follow-up streams out." },
      { from: "stream", to: "slack", note: "The promise is kept without anyone prodding." },
    ],
  },
  {
    id: "restart",
    title: "Restart without losing a message",
    blurb: "Self-update drains instead of dropping turns.",
    steps: [
      { at: "llm", note: "A merged fix runs bin/jarvis-restart.sh. Typecheck and tests first, or no restart." },
      { at: "receiver", note: "Draining: timers that start turns hold. New messages still run, each on a short budget (2 min by default); past it the thread hears \"hold on\" and the turn is cut." },
      { at: "queue", note: "Once the turns from before it finish, the inbox is no longer read. Past 15 minutes it exits anyway." },
      { from: "slack", to: "gateway", note: "Meanwhile people keep writing. The gateway never restarted." },
      { from: "gateway", to: "inbox", note: "Their messages wait as rows. Nothing is lost." },
      { from: "inbox", to: "receiver", note: "The new process reads the backlog. Cut turns resume on the same session." },
    ],
  },
];

export const DECISIONS: { title: string; body: string; cost: string }[] = [
  {
    title: "Two processes and a SQLite inbox",
    body: "The gateway holds the socket, the bot reads rows. A restart, a crash or a deploy never drops a Slack event.",
    cost: "One more process to supervise, and a poll interval of latency.",
  },
  {
    title: "One CLI session per thread",
    body: "Each thread resumes its own session, so the model keeps context and scratch files between turns without replaying history.",
    cost: "Turns in one thread are strictly serial.",
  },
  {
    title: "Tickets, not tokens, for the brain",
    body: "A turn calls commands with a one-turn ticket bound to the person being answered. It cannot pick a different actor or a higher role.",
    cost: "Every action needs an API route instead of a direct call.",
  },
  {
    title: "Polling over webhooks where there is no address",
    body: "The host sits behind NAT. Review requests are polled once a minute; only the GitHub App uses a webhook, through Funnel.",
    cost: "Up to a minute of delay on a review request.",
  },
  {
    title: "Memory as a checked, versioned adapter",
    body: "Facts and skills live in files with a gate and a revision on every save, not an append-only list that ends up contradicting itself.",
    cost: "Writing memory goes through a refine step.",
  },
  {
    title: "Drain, then restart",
    body: "A restart waits for running turns, answers new messages on a short budget meanwhile and refuses to start on a red build, so self-fixes cannot crash-loop.",
    cost: "A restart can take up to 15 minutes to land.",
  },
];

export const LAYERS: { name: string; rule: string; examples: string }[] = [
  { name: "domain", rule: "Pure rules. No I/O, no frameworks, unit tested without mocks.", examples: "access, toolPolicy, threadSession, adapter, watch" },
  { name: "application", rule: "Use cases over ports. Tested with in-memory SQLite and a fake LLM.", examples: "respond, handleMessage, commands, threadQueue, timers" },
  { name: "infrastructure", rule: "Adapters for Slack, the CLI, SQLite, GitHub, the host.", examples: "gateway, inboxReceiver, claudeCli, db repos, dashboard" },
  { name: "composition roots", rule: "Wire everything. Only these import every layer.", examples: "src/index.ts, src/gateway.ts" },
];

type Pt = { x: number; y: number };

/** Where a wire leaves a box: the point on its border facing the other box. */
const anchor = (a: Pt, b: Pt): Pt => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const s = Math.min((NODE.w / 2 + 4) / Math.abs(dx || 1e-9), (NODE.h / 2 + 4) / Math.abs(dy || 1e-9));
  return { x: a.x + dx * s, y: a.y + dy * s };
};

/** A wire as a quadratic curve: start, control, end. Neighbours get a gentle default bend. */
export const wireCurve = (e: SysEdge, a: Pt, b: Pt): [Pt, Pt, Pt] => {
  const p = anchor(a, b);
  const q = anchor(b, a);
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const bend = e.bend ?? Math.min(26, len * 0.12);
  return [
    p,
    { x: (p.x + q.x) / 2 - ((q.y - p.y) / len) * bend, y: (p.y + q.y) / 2 + ((q.x - p.x) / len) * bend },
    q,
  ];
};

/** A point along the curve, t in [0, 1]. */
export const curveAt = ([p, c, q]: [Pt, Pt, Pt], t: number): Pt => ({
  x: (1 - t) ** 2 * p.x + 2 * (1 - t) * t * c.x + t ** 2 * q.x,
  y: (1 - t) ** 2 * p.y + 2 * (1 - t) * t * c.y + t ** 2 * q.y,
});

/** Wires that run through a box they do not connect, as "from>to through id". */
export const wireCollisions = (nodes: SysNode[] = NODES, edges: SysEdge[] = EDGES, margin = 6): string[] => {
  const by = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  for (const e of edges) {
    const a = by.get(e.from);
    const b = by.get(e.to);
    if (!a || !b) continue;
    const curve = wireCurve(e, a, b);
    for (const n of nodes) {
      if (n === a || n === b) continue;
      for (let i = 1; i < 100; i++) {
        const pt = curveAt(curve, i / 100);
        if (Math.abs(pt.x - n.x) < NODE.w / 2 + margin && Math.abs(pt.y - n.y) < NODE.h / 2 + margin) {
          out.push(`${e.from}>${e.to} through ${n.id}`);
          break;
        }
      }
    }
  }
  return out;
};

/** Every box and wire a flow names must exist. Returns the problems, empty when sound. */
export const checkModel = (
  nodes: SysNode[] = NODES,
  edges: SysEdge[] = EDGES,
  flows: Flow[] = FLOWS,
): string[] => {
  const ids = new Set(nodes.map((n) => n.id));
  const wires = new Set(edges.map((e) => `${e.from}>${e.to}`));
  const problems: string[] = [];
  if (ids.size !== nodes.length) problems.push("duplicate node id");
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) problems.push(`edge ${e.from}>${e.to} names an unknown node`);
  }
  for (const f of flows) {
    f.steps.forEach((s, i) => {
      if ("at" in s) {
        if (!ids.has(s.at)) problems.push(`${f.id} step ${i + 1}: unknown node ${s.at}`);
      } else if (!wires.has(`${s.from}>${s.to}`)) {
        problems.push(`${f.id} step ${i + 1}: no wire ${s.from}>${s.to}`);
      }
    });
  }
  return problems;
};
