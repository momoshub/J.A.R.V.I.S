/**
 * Workflow front/worker split - the rules, no I/O.
 *
 * A workflow's worker session does the task one step at a time, and every
 * human message used to queue behind the running step on the same session:
 * "status?" waited for a step to finish before anything answered. Now a human
 * message goes to a separate front session on its own queue. The front answers
 * from a progress digest built at turn time, and when the message is meant for
 * the work - an instruction, an answer, a change of plan - it emits
 * `[steer] <instruction>` lines. Those are stripped from what is posted and
 * handed to the worker at its next step.
 */
import { forHowLong } from "./runControl.ts";
import type { WorkerReply, WorkflowSteer } from "./types.ts";

/** What the front puts at the start of a line to pass something to the worker. */
export const STEER_MARKER = "[steer]";

/** The front answers questions; it does not do the work. Keep it quick. */
export const FRONT_TIMEOUT_MS = 240_000;

/** Tool calls shown in the digest, newest last. */
export const DIGEST_CALLS = 15;

/** Worker replies kept on the row, and shown in the digest. */
export const WORKER_REPLIES_KEPT = 3;

/** Longest worker reply kept on the row. */
export const WORKER_REPLY_CHARS = 600;

/** Queue (and run registry) key of a thread's front, beside the worker's own. */
export const frontKeyOf = (threadKey: string): string => `${threadKey}:front`;

export type ParsedFront = {
  /** The reply with every steer line taken out - what the thread should see. */
  readonly text: string;
  /** Instructions for the worker, in the order they were written. */
  readonly steers: readonly string[];
};

/** Leading decoration a model may wrap a marker line in. */
const LEAD = /^[\s`*_>-]*/;
const STEER_LINE = /^[\s`*_>-]*\[steer\][`*_]*\s*(.*?)[\s`*_]*$/i;

/** Read the front's reply: what to post, and what to pass on to the worker. */
export const parseSteers = (raw: string): ParsedFront => {
  const steers: string[] = [];
  const kept: string[] = [];
  for (const line of raw.split("\n")) {
    const m = STEER_LINE.exec(line);
    if (!m) {
      kept.push(line);
      continue;
    }
    const instruction = (m[1] ?? "").trim();
    if (instruction) steers.push(instruction);
  }
  return { text: kept.join("\n").trim(), steers };
};

/**
 * Strip steer lines out of a live stream. A line is held back only while it
 * could still turn out to be a steer (`[st` ...); once it cannot, it flows
 * through untouched, and once it is one, everything up to its newline is
 * dropped. `flush` releases a held fragment, before a non-text event.
 */
export const createSteerFilter = (): { push: (delta: string) => string; flush: () => string } => {
  let mode: "start" | "pass" | "drop" = "start";
  let held = "";
  const push = (delta: string): string => {
    let out = "";
    for (const ch of delta) {
      if (mode === "pass") {
        out += ch;
        if (ch === "\n") mode = "start";
        continue;
      }
      if (mode === "drop") {
        if (ch === "\n") mode = "start";
        continue;
      }
      held += ch;
      const probe = held.replace(LEAD, "").toLowerCase();
      if (probe.startsWith(STEER_MARKER)) {
        held = "";
        mode = ch === "\n" ? "start" : "drop";
      } else if (ch === "\n") {
        out += held;
        held = "";
      } else if (!STEER_MARKER.startsWith(probe)) {
        out += held;
        held = "";
        mode = "pass";
      }
    }
    return out;
  };
  const flush = (): string => {
    const out = held;
    held = "";
    if (out) mode = "pass";
    return out;
  };
  return { push, flush };
};

/** One worker tool call, as the digest shows it. */
export type DigestCall = {
  /** ISO time it was made. */
  readonly at: string;
  readonly name: string;
  /** The call's input, raw (usually JSON). */
  readonly input: string;
  readonly isError?: boolean;
};

export type WorkerState =
  | { readonly state: "running"; readonly since: number }
  | { readonly state: "queued" }
  | { readonly state: "idle" };

export type DigestInput = {
  readonly now: number;
  readonly worker: WorkerState;
  readonly turns: number;
  readonly autoTurns: number;
  readonly steers: readonly WorkflowSteer[];
  readonly replies: readonly WorkerReply[];
  readonly calls: readonly DigestCall[];
};

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** The part of a tool input worth a glance: the command, the path, the query. */
export const callSummary = (input: string): string => {
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      for (const k of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
        const v = o[k];
        if (typeof v === "string" && v.trim()) return v;
      }
    }
  } catch {
    // not JSON - show it as it is
  }
  return input;
};

const ago = (now: number, at: number): string => `${forHowLong(now - at)} ago`;

const workerLine = (w: WorkerState, now: number): string => {
  if (w.state === "running") return `worker: running a step right now, for ${forHowLong(now - w.since)}`;
  if (w.state === "queued") return "worker: between steps, the next one is queued";
  return "worker: idle - nothing running or queued (done, paused, or waiting on a human)";
};

/**
 * What the front is told about the work, every turn. Small on purpose: it is
 * there to answer "where are we?" quickly, not to replay the session.
 */
export const buildDigest = (d: DigestInput): string => {
  const lines = [
    `Progress digest (built just now):`,
    workerLine(d.worker, d.now),
    `steps so far: ${d.turns} (${d.autoTurns} on its own since it was last steered)`,
  ];
  if (d.steers.length > 0) {
    lines.push("passed on, not yet seen by the worker:");
    for (const s of d.steers) lines.push(`- <@${s.by}>: ${oneLine(s.text, 200)}`);
  }
  lines.push(d.replies.length > 0 ? "worker's last replies in the thread (newest last):" : "worker has not replied yet.");
  for (const r of d.replies) lines.push(`- [${ago(d.now, r.at)}] ${oneLine(r.text, 300)}`);
  const calls = d.calls.slice(-DIGEST_CALLS);
  if (calls.length > 0) {
    lines.push("worker's recent tool calls (newest last):");
    for (const c of calls) {
      const at = Date.parse(c.at);
      const when = Number.isFinite(at) ? `[${ago(d.now, at)}] ` : "";
      lines.push(`- ${when}${c.name}: ${oneLine(callSummary(c.input), 140)}${c.isError ? " (failed)" : ""}`);
    }
  } else {
    lines.push("no worker tool calls on record.");
  }
  return lines.join("\n");
};

/** Keep the newest `WORKER_REPLIES_KEPT` replies, each clipped. */
export const keepReplies = (replies: readonly WorkerReply[], next: WorkerReply): WorkerReply[] =>
  [...replies, { at: next.at, text: next.text.slice(0, WORKER_REPLY_CHARS) }].slice(-WORKER_REPLIES_KEPT);

/**
 * The worker's next-step message, with what people said mid-task. Each steer
 * names its author with their Slack tag, so the worker can mention them back.
 */
export const steeredMessage = (
  base: string,
  steers: readonly WorkflowSteer[],
  nameOf: (slackId: string) => string | undefined,
): string => {
  if (steers.length === 0) return base;
  const said = steers.map((s) => {
    const name = nameOf(s.by)?.trim();
    return `${name ? `${name} (<@${s.by}>)` : `<@${s.by}>`} said mid-task: ${s.text}`;
  });
  return `${said.join("\n")}\n\nFold that into the work, then ${base}.`;
};

/** The front's user message: the digest, then what the person said. */
export const frontMessage = (digest: string, text: string): string =>
  `${digest}\n\n---\nThe message to answer:\n${text}`;
