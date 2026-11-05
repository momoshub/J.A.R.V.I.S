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
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BillingContext, ToolTrace, ToolTraceSink } from "../../application/ports.ts";
import { redactSecrets } from "../../domain/toolVisibility.ts";

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
