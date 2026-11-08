/**
 * What Orca is doing, for `sys`: is the runtime there, how many Runs are live,
 * and which workers are on what.
 *
 * Pure: the probe (`infrastructure/system/orcaProbe.ts`) hands over the raw
 * `--json` stdout of `orca status`, `orchestration run-list` and one
 * `orchestration task-list --run` per Run, and everything here parses and
 * counts it. A field Orca does not send is left out rather than guessed, and
 * stdout that is not the expected JSON parses to undefined, never a throw: a
 * changed CLI must cost the Orca section, not the whole `sys` reply.
 *
 * Task status is the unit, not worker terminals: `dispatched` is a worker on
 * it, `blocked` is one waiting on a gate or an answer, `pending`/`ready` is not
 * started yet. A Run is active while any of its tasks is one of those.
 */
import { duration } from "./systemStatus.ts";

export type OrcaRuntime = {
  readonly reachable: boolean;
  /** `ready`, `starting`... whatever Orca calls it. */
  readonly state: string;
  readonly appRunning: boolean;
  readonly appPid?: number;
  readonly version?: string;
};

export type OrcaRunRow = {
  readonly id: string;
  readonly objective: string;
  readonly createdAt?: number;
};

export type OrcaTaskRow = {
  readonly id: string;
  readonly runId: string;
  readonly title: string;
  readonly status: string;
  readonly createdAt?: number;
};

export type OrcaSnapshot =
  | { readonly kind: "unreachable"; readonly reason: string }
  | {
      readonly kind: "ok";
      readonly runtime: OrcaRuntime;
      /** The Runs that were read, newest first. */
      readonly runs: readonly OrcaRunRow[];
      readonly tasks: readonly OrcaTaskRow[];
      /** Runs whose task list could not be read, so the counts are a floor. */
      readonly unreadRuns: number;
      /** Orca has older Runs past the ones scanned. */
      readonly moreRuns: boolean;
    };

const LIVE = new Set(["dispatched", "blocked"]);
const OPEN = new Set(["pending", "ready", "dispatched", "blocked"]);

const record = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** Orca's `result` object, when the call answered ok. */
const resultOf = (stdout: string): Record<string, unknown> | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const top = record(value);
  return top?.ok === true ? record(top.result) : undefined;
};

/** `2026-11-08 09:57:36` (SQLite, UTC) or ISO. */
export const orcaTime = (v: unknown): number | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms : undefined;
};

/** `orca status --json`. */
export const parseOrcaStatus = (stdout: string): OrcaRuntime | undefined => {
  const r = resultOf(stdout);
  const runtime = record(r?.runtime);
  if (!r || !runtime) return undefined;
  const app = record(r.app);
  const pid = app?.pid;
  const version = str(runtime.appVersion);
  return {
    reachable: runtime.reachable === true,
    state: str(runtime.state) ?? "unknown",
    appRunning: app?.running === true,
    ...(typeof pid === "number" ? { appPid: pid } : {}),
    ...(version ? { version } : {}),
  };
};

/** `orca orchestration run-list --json [--full]`. */
export const parseRunList = (stdout: string): { runs: OrcaRunRow[]; more: boolean } | undefined => {
  const r = resultOf(stdout);
  if (!r || !Array.isArray(r.runs)) return undefined;
  const runs = r.runs.flatMap((x): OrcaRunRow[] => {
    const row = record(x);
    const id = str(row?.id);
    if (!row || !id) return [];
    const createdAt = orcaTime(row.created_at);
    return [{ id, objective: str(row.objective) ?? id, ...(createdAt !== undefined ? { createdAt } : {}) }];
  });
  return { runs, more: str(r.nextCursor) !== undefined };
};

/** `orca orchestration task-list --run <id> --json [--full --brief]`. */
export const parseTaskList = (stdout: string, runId: string): OrcaTaskRow[] | undefined => {
  const r = resultOf(stdout);
  if (!r || !Array.isArray(r.tasks)) return undefined;
  return r.tasks.flatMap((x): OrcaTaskRow[] => {
    const row = record(x);
    const id = str(row?.id);
    if (!row || !id) return [];
    const createdAt = orcaTime(row.created_at);
    return [
      {
        id,
        runId: str(row.run_id) ?? runId,
        title: str(row.task_title) ?? str(row.display_name) ?? str(row.title) ?? id,
        status: str(row.status) ?? "unknown",
        ...(createdAt !== undefined ? { createdAt } : {}),
      },
    ];
  });
};

export type OrcaCounts = {
  readonly running: number;
  readonly waiting: number;
  readonly queued: number;
  readonly completed: number;
  readonly failed: number;
};

export type LiveWorker = {
  readonly title: string;
  readonly run: string;
  readonly status: "running" | "waiting";
  /** Seconds since the task was created, when Orca said. */
  readonly ageS?: number;
};

export type OrcaSummary =
  | { readonly kind: "unreachable"; readonly reason: string }
  | {
      readonly kind: "ok";
      readonly runtime: OrcaRuntime;
      readonly activeRuns: number;
      readonly scannedRuns: number;
      readonly counts: OrcaCounts;
      /** Oldest first: the one that has been at it longest is the one to look at. */
      readonly live: readonly LiveWorker[];
      readonly unreadRuns: number;
      readonly moreRuns: boolean;
    };

export const summarizeOrca = (s: OrcaSnapshot, now: number): OrcaSummary => {
  if (s.kind === "unreachable") return s;
  const objective = new Map(s.runs.map((r) => [r.id, r.objective]));
  const count = (...st: string[]) => s.tasks.filter((t) => st.includes(t.status)).length;
  const live = s.tasks
    .filter((t) => LIVE.has(t.status))
    .map((t): LiveWorker & { at: number } => ({
      title: t.title,
      run: objective.get(t.runId) ?? t.runId,
      status: t.status === "blocked" ? "waiting" : "running",
      ...(t.createdAt !== undefined ? { ageS: Math.max(0, (now - t.createdAt) / 1000) } : {}),
      at: t.createdAt ?? now,
    }))
    .sort((a, b) => a.at - b.at)
    .map(({ at: _at, ...w }) => w);
  return {
    kind: "ok",
    runtime: s.runtime,
    activeRuns: new Set(s.tasks.filter((t) => OPEN.has(t.status)).map((t) => t.runId)).size,
    scannedRuns: s.runs.length,
    counts: {
      running: count("dispatched"),
      waiting: count("blocked"),
      queued: count("pending", "ready"),
      completed: count("completed"),
      failed: count("failed"),
    },
    live,
    unreadRuns: s.unreadRuns,
    moreRuns: s.moreRuns,
  };
};

/** The runtime in a few words: `ready, app pid 56481, v1.4.253`. */
export const orcaRuntimeLine = (r: OrcaRuntime): string =>
  [
    r.reachable ? r.state : `${r.state}, not reachable`,
    r.appPid !== undefined ? `app pid ${r.appPid}` : r.appRunning ? "app running" : "app not running",
    r.version ? `v${r.version}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");

/** The counts as one phrase, zeros left out except running. */
export const orcaCountsLine = (c: OrcaCounts): string =>
  [
    `${c.running} running`,
    c.waiting ? `${c.waiting} waiting for input` : undefined,
    c.queued ? `${c.queued} queued` : undefined,
    `${c.completed} completed`,
    c.failed ? `${c.failed} failed` : undefined,
  ]
    .filter(Boolean)
    .join(", ");

/** Why the counts may be short, or nothing. */
export const orcaCaveat = (s: Extract<OrcaSummary, { kind: "ok" }>): string | undefined => {
  const parts = [
    s.moreRuns ? `latest ${s.scannedRuns} runs` : undefined,
    s.unreadRuns ? `${s.unreadRuns} unread` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
};

/** How many live workers the text form lists before "and N more". */
export const LIVE_TEXT_ROWS = 5;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Mrkdwn lines for the plain-text report (and the Block Kit fallback). */
export const describeOrca = (s: OrcaSummary): string[] => {
  if (s.kind === "unreachable") return [`*orca* unreachable (${s.reason})`];
  const caveat = orcaCaveat(s);
  const lines = [
    `*orca* ${orcaRuntimeLine(s.runtime)} - ${s.activeRuns} active run${s.activeRuns === 1 ? "" : "s"}: ${orcaCountsLine(s.counts)}${caveat ? ` _(${caveat})_` : ""}`,
  ];
  for (const w of s.live.slice(0, LIVE_TEXT_ROWS)) {
    lines.push(
      `- ${clip(w.title, 60)} (${clip(w.run, 40)}${w.ageS !== undefined ? `, ${duration(w.ageS)}` : ""}${w.status === "waiting" ? ", waiting for input" : ""})`,
    );
  }
  if (s.live.length > LIVE_TEXT_ROWS) lines.push(`- and ${s.live.length - LIVE_TEXT_ROWS} more`);
  return lines;
};
