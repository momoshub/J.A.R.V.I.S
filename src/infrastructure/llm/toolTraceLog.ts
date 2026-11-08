/**
 * Every tool call and result, one file per Slack thread.
 *
 * The cards in Slack are clipped to a line and then collapsed away when the
 * turn ends, so once a turn is over nothing shows what it actually ran or what
 * came back. This is the record for debugging it later:
 * `<dir>/<channel>/<threadTs>.jsonl`, one JSON line per call or result, in
 * order. A run with no thread (a dashboard action, a timer) goes under `_none`.
 *
 * Credential-shaped strings are redacted, and a huge output is clipped - a
 * debug log that fills the disk with one `cat` of a binary is its own outage.
 */
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { BillingContext, ToolTrace, ToolTraceSink } from "../../application/ports.ts";
import { redactSecrets } from "../../domain/toolVisibility.ts";
import type { DigestCall } from "../../domain/workflowFront.ts";

/** Longest input or output kept per line. */
export const TRACE_FIELD_CHARS = 100_000;

/** Ids and timestamps only: nothing that could walk out of the directory. */
const safe = (part: string): string => part.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "_";

const clip = (text: string): string =>
  text.length <= TRACE_FIELD_CHARS
    ? text
    : `${text.slice(0, TRACE_FIELD_CHARS)}\n…[clipped ${text.length - TRACE_FIELD_CHARS} chars]`;

/** Where one run's trace lands. */
export const traceFileFor = (dir: string, bill: BillingContext | undefined, now: Date): string =>
  bill?.channel
    ? join(dir, safe(bill.channel), `${safe(bill.threadTs ?? "no-thread")}.jsonl`)
    : join(dir, "_none", `${now.toISOString().slice(0, 10)}.jsonl`);

/** The line written for one trace. */
export const traceLine = (trace: ToolTrace, bill: BillingContext | undefined, now: Date): string => {
  const body =
    trace.kind === "call"
      ? { ...trace, input: clip(redactSecrets(trace.input)) }
      : { ...trace, output: clip(redactSecrets(trace.output)) };
  return `${JSON.stringify({ at: now.toISOString(), actor: bill?.actor, run: bill?.kind, ...body })}\n`;
};

export const createToolTraceLog = (dir: string, clock: () => Date = () => new Date()): ToolTraceSink => {
  const made = new Set<string>();
  return (trace, bill) => {
    const now = clock();
    const file = traceFileFor(dir, bill, now);
    const folder = join(file, "..");
    if (!made.has(folder)) {
      mkdirSync(folder, { recursive: true });
      made.add(folder);
    }
    appendFileSync(file, traceLine(trace, bill, now));
  };
};

/** How much of the end of a thread's trace is read for a digest. */
export const TRACE_TAIL_BYTES = 512 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The last `bytes` of a file, or "" when there is no file. */
const readTail = (file: string, bytes: number): string => {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const text = buf.toString("utf8");
    // A cut-off first line is not a line; skip it unless the whole file fit.
    return length < size ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

/**
 * The raw end of a thread's whole trace (every run kind), for a reader that
 * parses it itself. "" when there is none. Never throws.
 */
export const readThreadTrace = (dir: string, channel: string, threadTs: string, tailBytes: number): string =>
  readTail(traceFileFor(dir, { actor: "", kind: "", channel, threadTs }, new Date()), tailBytes);

/**
 * The newest tool calls in a thread's trace, made by runs of `kind` (the
 * worker's billing kind), oldest first, each marked if its result was an
 * error. Reads only the end of the file, so a thread with a long history
 * costs the same as a short one. Never throws.
 */
export const readTraceCalls = (
  dir: string,
  channel: string,
  threadTs: string,
  kind: string,
  limit: number,
  tailBytes = TRACE_TAIL_BYTES,
): DigestCall[] => {
  const file = traceFileFor(dir, { actor: "", kind, channel, threadTs }, new Date());
  const calls: { id: string; call: DigestCall }[] = [];
  const failed = new Set<string>();
  for (const line of readTail(file, tailBytes).split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row) || row.run !== kind || typeof row.id !== "string") continue;
    if (row.kind === "result" && row.isError === true) failed.add(row.id);
    if (row.kind === "call" && typeof row.name === "string") {
      calls.push({
        id: row.id,
        call: { at: typeof row.at === "string" ? row.at : "", name: row.name, input: typeof row.input === "string" ? row.input : "" },
      });
    }
  }
  return calls.slice(-limit).map(({ id, call }) => (failed.has(id) ? { ...call, isError: true } : call));
};
