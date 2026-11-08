/**
 * Which background agents a thread's turns started, and which of them may be
 * stopped from that thread.
 *
 * `stop` used to end only the thread's `claude -p` process. That kills what
 * runs INSIDE it - the Agent tool's background agents are in-process in a
 * `-p` turn, and the model's shells are its children - but two kinds of
 * background agent live outside that tree and kept working after a stop:
 *
 * - a `claude --bg` session, hosted by the Claude Code daemon. It does not
 *   inherit the turn's environment and the daemon records no parent for it
 *   (verified: a marker variable set on the `claude --bg` call was absent from
 *   the session's process and its shells, and the daemon's `--spawned-by` is
 *   only whoever started the daemon first - the daemon is shared, so that pid
 *   names someone else's session as often as ours).
 * - an Orca worker, started with `orca orchestration worker-start`, which runs
 *   in a terminal Orca owns.
 *
 * Neither can be found from a pid or a cwd without catching other people's
 * sessions. What does link them to the thread is the thread's own tool trace
 * (`<LOG_DIR>/threads/<channel>/<threadTs>.jsonl`): the call that launched each
 * one and the id it printed back. So a launch counts only when BOTH hold - the
 * Bash call really ran that launcher, and its result carries the id - and it
 * is stopped through the tool's own CLI (`claude stop <id>`,
 * `orca orchestration worker-stop --dispatch <id>`), never by signalling a pid.
 * A turn that merely reads a log mentioning some id is not a launch, and a
 * call that runs anything besides launchers, or printed more ids than it ran
 * launchers, counts for none of them.
 */

export type BackgroundKind = "claude-bg" | "orca-worker";

export type BackgroundLaunch = {
  readonly kind: BackgroundKind;
  readonly id: string;
  /** Slack id of whoever the launching run belonged to, when the trace says. */
  readonly actor?: string;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The shell command of a Bash call's input JSON, or "" for anything else. */
export const bashCommand = (name: unknown, input: unknown): string => {
  if (name !== "Bash" || typeof input !== "string") return "";
  try {
    const parsed: unknown = JSON.parse(input);
    return isRecord(parsed) && typeof parsed.command === "string" ? parsed.command : "";
  } catch {
    return "";
  }
};

/**
 * Where a command starts: the line start, after `;` `&` `|` `(` or `$(`, past
 * any `VAR=value` assignments and a `nohup`/`env`/`exec`/`command` prefix. A
 * launcher has to be IN command position - `grep "claude --bg" logs/` names
 * the launcher in a quoted pattern and must not count as running it.
 */
const COMMAND_START = String.raw`(?:^|[;&|(\n]|\$\()\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:nohup|env|exec|command)\s+)*(?:\S*\/)?`;
/** A `claude` invocation carrying `--bg`/`--background` on the same command. */
const CLAUDE_BG_CALL = new RegExp(`${COMMAND_START}claude\\s[^\\n;&|]*?--(?:bg|background)(?![-\\w])`, "gm");
/** What `claude --bg` prints as its first line: `backgrounded · cfaf8d7a`. */
const CLAUDE_BG_ID = /^\s*backgrounded\s*·\s*([0-9a-f]{8})\b/gm;
const ORCA_WORKER_CALL = new RegExp(`${COMMAND_START}orca\\s+orchestration\\s+worker-start\\b`, "gm");
/** A dispatch id, as `worker-start` prints it (`"dispatchId":"ctx_..."`, or `dispatch ctx_...`). */
const ORCA_DISPATCH_ID = /"dispatchId"\s*:\s*"(ctx_[0-9a-f]{6,})"|\bdispatch(?:Id)?[\s=:]+(ctx_[0-9a-f]{6,})\b/g;
/**
 * `worker-start` flags that put the worker somewhere `stop` must not close:
 * `--terminal` adopts a terminal that already exists (a person's agent pane -
 * `worker-stop` closes the worker's terminal), and `--on`/`--environment`/
 * `--pairing-code` run it on another Orca server the local CLI cannot see.
 * Matched anywhere in the command, so a quoted spec naming one only makes it
 * skip more.
 */
const ORCA_NOT_OURS_TO_CLOSE = /(?:^|\s)--(?:terminal|on|environment|pairing-code)(?=[\s=]|$)/m;

const idsIn = (text: string, pattern: RegExp): string[] => [
  ...new Set([...text.matchAll(pattern)].map((m) => m[1] ?? m[2] ?? "").filter(Boolean)),
];

const count = (text: string, pattern: RegExp): number => [...text.matchAll(pattern)].length;

/** Harmless setup as one whole simple command: `cd`, `export`, bare assignments. */
const SETUP_SEGMENT = /^\s*(?:(?:cd|export)(?:\s.*)?|(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s*)*)$/;
const CLAUDE_BG_AT = new RegExp(CLAUDE_BG_CALL.source);
const ORCA_WORKER_AT = new RegExp(ORCA_WORKER_CALL.source);
const ORCA_WORKER_ANYWHERE = new RegExp(ORCA_WORKER_CALL.source, "m");
/** Whether a command runs `orca orchestration worker-start` in command position somewhere. */
export const runsOrcaWorkerStart = (command: string): boolean => ORCA_WORKER_ANYWHERE.test(command);
/** A launcher that starts the segment, or harmless setup. */
const isLaunchSegment = (segment: string): boolean =>
  SETUP_SEGMENT.test(segment) || segment.search(CLAUDE_BG_AT) === 0 || segment.search(ORCA_WORKER_AT) === 0;

/**
 * Whether a command runs nothing but launchers (and `cd`/`export`/assignments).
 * The output is the whole command's, so anything else chained on - a
 * `task-list` on the shared Run, a `tail` of another launch's log - can print
 * an id the launcher did not, and when the launcher itself failed a count of
 * ids cannot tell the two apart. Quoted text is blanked first so a spec with a
 * `;` in it stays one command, and redirections like `2>&1` are not chains.
 */
const onlyLaunches = (command: string): boolean => {
  const bare = command
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
    .replace(/\d*>&\d*-?|&>>?/g, " ");
  return bare
    .split(/&&|\|\||[;|&\n]/)
    .every((segment) => !segment.trim() || isLaunchSegment(segment));
};

/**
 * The ids one call's output shows its own launchers started. The output is the
 * whole command's, so `worker-start && task-list` or `claude --bg x; cat old.out`
 * carry other ids too - possibly other threads'. A call whose output holds MORE
 * distinct ids than it ran launchers cannot say which are its own, and counts
 * for none of them: a launch missed is a session left running, a launch
 * misread is someone else's work stopped. (So a loop of launches in one call is
 * not seen either.) And a call that chains anything but launchers onto them
 * counts for none (`onlyLaunches`): a failed launch next to one foreign id
 * would otherwise pass the count.
 */
const ownIds = (command: string, output: string, launcher: RegExp, id: RegExp): string[] => {
  const launchers = count(command, launcher);
  if (launchers === 0 || !onlyLaunches(command)) return [];
  const ids = idsIn(output, id);
  return ids.length <= launchers ? ids : [];
};

/**
 * Every background agent a thread's trace shows being launched, oldest first,
 * each once. `traceText` is the raw JSONL. Never throws: a line that does not
 * parse is skipped.
 */
export const backgroundLaunches = (traceText: string): BackgroundLaunch[] => {
  const calls = new Map<string, { command: string; actor?: string }>();
  const seen = new Set<string>();
  const out: BackgroundLaunch[] = [];
  for (const line of traceText.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row) || typeof row.id !== "string") continue;
    if (row.kind === "call") {
      const command = bashCommand(row.name, row.input);
      if (command) calls.set(row.id, { command, actor: typeof row.actor === "string" ? row.actor : undefined });
      continue;
    }
    if (row.kind !== "result" || typeof row.output !== "string") continue;
    const call = calls.get(row.id);
    if (!call) continue;
    const found: { kind: BackgroundKind; ids: string[] }[] = [
      { kind: "claude-bg", ids: ownIds(call.command, row.output, CLAUDE_BG_CALL, CLAUDE_BG_ID) },
      {
        kind: "orca-worker",
        ids: ORCA_NOT_OURS_TO_CLOSE.test(call.command) ? [] : ownIds(call.command, row.output, ORCA_WORKER_CALL, ORCA_DISPATCH_ID),
      },
    ];
    for (const { kind, ids } of found) {
      for (const id of ids) {
        const key = `${kind}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind, id, ...(call.actor ? { actor: call.actor } : {}) });
      }
    }
  }
  return out;
};

/**
 * Whose launches a requester may stop: their own, or anyone's for an admin -
 * the same rule as stopping a turn. A launch with no recorded actor is treated
 * as somebody else's.
 */
export const mayStopLaunch = (launch: BackgroundLaunch, requester: string, mayStopOthers: boolean): boolean =>
  mayStopOthers || launch.actor === requester;

/** One row of `claude agents --json`. */
export type AgentEntry = { readonly id?: string; readonly kind?: string; readonly state?: string };

/** `claude agents --json`, or undefined when it is not that shape (a failed check, not an empty list). */
export const parseAgentsList = (stdout: string): AgentEntry[] | undefined => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter(isRecord).map((e) => ({
      id: typeof e.id === "string" ? e.id : undefined,
      kind: typeof e.kind === "string" ? e.kind : undefined,
      state: typeof e.state === "string" ? e.state : undefined,
    }));
  } catch {
    return undefined;
  }
};

/** States a background session reports once it has nothing left to do. */
const FINISHED_STATES = new Set(["done", "failed", "error", "stopped", "exited", "killed"]);

/**
 * The thread's `claude --bg` sessions that are still going. Only a `background`
 * entry whose id the thread itself launched counts: an interactive session (a
 * person's own Claude, or another thread's `claude -p`) is never on this list,
 * whatever its id, and neither is a session that already finished.
 */
export const liveClaudeSessions = (launched: readonly string[], agents: readonly AgentEntry[]): string[] => {
  const ours = new Set(launched);
  return agents
    .filter((a) => a.id && ours.has(a.id) && a.kind === "background" && !FINISHED_STATES.has(a.state ?? ""))
    .map((a) => a.id ?? "");
};

/** What a tool said about one launch: still going, gone, or it could not tell. */
export type Liveness = "live" | "gone" | "unknown";

/**
 * What `orca orchestration worker-show --json` says about a worker. Settled,
 * exited, finished or `dispatch_not_found` is gone; output that is not a
 * worker record at all is unknown - a failed check must never read as
 * "nothing to stop".
 */
export const orcaWorkerLiveness = (stdout: string): Liveness => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed)) return "unknown";
    if (parsed.ok !== true) {
      return isRecord(parsed.error) && parsed.error.code === "dispatch_not_found" ? "gone" : "unknown";
    }
    if (!isRecord(parsed.result)) return "unknown";
    const { stage, liveness, state } = parsed.result;
    if (stage === "settled" || liveness === "exited") return "gone";
    return typeof state === "string" && ["succeeded", "failed", "cancelled", "stopped"].includes(state) ? "gone" : "live";
  } catch {
    return "unknown";
  }
};

export type BackgroundStopResult = {
  readonly stopped: readonly BackgroundLaunch[];
  readonly failed: readonly (BackgroundLaunch & { readonly reason: string })[];
  /** Live launches left alone because they were somebody else's. */
  readonly notYours: readonly BackgroundLaunch[];
  /** Launches whose tool could not say whether they are still going. */
  readonly unchecked: readonly (BackgroundLaunch & { readonly reason: string })[];
};

export const NOTHING_IN_BACKGROUND: BackgroundStopResult = { stopped: [], failed: [], notYours: [], unchecked: [] };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "1 background agent and 2 Orca workers", or "" for none. */
export const describeBackground = (launches: readonly BackgroundLaunch[]): string => {
  const bg = launches.filter((l) => l.kind === "claude-bg").length;
  const orca = launches.filter((l) => l.kind === "orca-worker").length;
  const parts = [
    bg > 0 ? plural(bg, "background agent", "background agents") : "",
    orca > 0 ? plural(orca, "Orca worker", "Orca workers") : "",
  ].filter(Boolean);
  return parts.join(" and ");
};

const ids = (launches: readonly BackgroundLaunch[]): string => launches.map((l) => `\`${l.id}\``).join(", ");

/**
 * The `stop` reply: what happened to the turn, then what happened in the
 * background. `turnLine` is the turn's own sentence, or undefined when no
 * turn was running. Returns undefined when there is nothing to say at all, so
 * the caller can keep its own "nothing is running" wording.
 */
export const stopReply = (turnLine: string | undefined, bg: BackgroundStopResult): string | undefined => {
  const lines: string[] = [];
  const stopped = describeBackground(bg.stopped);
  const started = `${stopped} this thread started (${ids(bg.stopped)})`;
  if (!turnLine) {
    if (stopped) lines.push(`⏹ stopped ${started}`);
  } else if (!stopped) lines.push(turnLine);
  // A turn notice that is a whole sentence ("finished on its own just now.")
  // takes the background part on a line of its own.
  else if (/[.!?]$/.test(turnLine)) lines.push(turnLine, `⏹ also stopped ${started}`);
  else lines.push(`${turnLine}, and ${stopped} it started (${ids(bg.stopped)})`);
  if (bg.failed.length > 0) {
    lines.push(
      `could not stop ${describeBackground(bg.failed)}: ${bg.failed.map((f) => `\`${f.id}\` (${f.reason})`).join(", ")}`,
    );
  }
  if (bg.unchecked.length > 0) {
    lines.push(
      `could not check whether ${describeBackground(bg.unchecked)} this thread started ${bg.unchecked.length === 1 ? "is" : "are"} still running, so I left ${bg.unchecked.length === 1 ? "it" : "them"}: ${bg.unchecked.map((f) => `\`${f.id}\` (${f.reason})`).join(", ")}`,
    );
  }
  if (bg.notYours.length > 0) {
    const owners = [...new Set(bg.notYours.map((l) => (l.actor ? `<@${l.actor}>` : "someone else")))].join(", ");
    lines.push(`left ${describeBackground(bg.notYours)} running that belong to ${owners} - only they or an admin can stop them`);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
};
