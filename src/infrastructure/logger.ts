/**
 * Activity log - appends every bot activity to a `logs/` folder as JSON lines,
 * so there is a durable trail beyond the console and the dashboard's DB history.
 *
 * - `activity-YYYY-MM-DD.log` : one line per event (messages, commands, errors)
 * - `errors.log`             : errors and failed commands only, for quick triage
 *
 * Writes are best-effort and never throw, so logging can't take the bot down.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export type ActivityLog = {
  /** Record an informational event. */
  event: (event: string, data?: Record<string, unknown>) => void;
  /** Record an error/failure (also mirrored to errors.log + stderr). */
  error: (event: string, data?: Record<string, unknown>) => void;
  /** Plain-string sink for adapters that only have a `log(msg)` seam. */
  line: (msg: string) => void;
  /** Absolute path of the log directory. */
  readonly dir: string;
};

const stamp = (): string => new Date().toISOString();
const day = (): string => stamp().slice(0, 10);

export const createActivityLog = (dir = "logs"): ActivityLog => {
  const base = resolve(dir);
  mkdirSync(base, { recursive: true });

  const append = (file: string, rec: Record<string, unknown>): void => {
    try {
      appendFileSync(join(base, file), `${JSON.stringify(rec)}\n`);
    } catch {
      // never let logging crash the bot
    }
  };

  const event = (event: string, data: Record<string, unknown> = {}): void => {
    append(`activity-${day()}.log`, { ts: stamp(), level: "info", event, ...data });
  };

  const error = (event: string, data: Record<string, unknown> = {}): void => {
    const rec = { ts: stamp(), level: "error", event, ...data };
    append(`activity-${day()}.log`, rec);
    append("errors.log", rec);
    console.error(`[error] ${event}`, data);
  };

  const line = (msg: string): void => {
    console.log(`[slack] ${msg}`);
    // an adapter log line is an error if it announces a failure
    if (/fail|error|reject/i.test(msg)) error("slack", { msg });
    else event("slack", { msg });
  };

  return { event, error, line, dir: base };
};
