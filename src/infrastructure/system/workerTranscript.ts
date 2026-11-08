/**
 * Which Claude Code transcript belongs to an Orca worker, and what it used.
 *
 * Orca never names the worker's session, and `worker-start` takes no way to
 * hand the agent a `--session-id` (its flags are placement, agent, model and
 * effort). What Orca DOES keep is the transcript itself: `worker-read
 * --source transcript` returns the worker's messages with their ids, and
 * those ids are the `uuid` of the lines in the session's jsonl - verified
 * against a live worker. So the link is exact, not a guess by time: take one
 * message id, find the jsonl under the worker's project folder (from the
 * terminal's `worktreePath` in `worker-show`) that holds it, and that file's
 * name is the session id. Only when the worker's folder is unknown or does not
 * hold it are the other project folders searched, newest first, limited to
 * files written since the dispatch started.
 *
 * Every Orca call goes through `OrcaRun` (bounded, never throws); every miss is
 * an `error`, never a throw.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { OrcaRun } from "./orcaTerminal.ts";
import { projectSlug, sumTranscripts, workerUsage, type WorkerUsage } from "../../domain/workerUsage.ts";

export type WorkerSession = {
  readonly dispatchId: string;
  readonly sessionId: string;
  /** The session jsonl, then any subagent transcripts under it. */
  readonly files: readonly string[];
  readonly runId?: string;
  readonly cwd?: string;
  /** When Orca dispatched it, epoch ms. */
  readonly startedAt?: number;
};

export type TranscriptDeps = {
  readonly orca: OrcaRun;
  /** Claude Code's projects folder; default `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
  readonly projectsDir?: string;
  /** A `worker-show --json --full` answer the caller already has, to save a call. */
  readonly shown?: string;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

const json = (stdout: string): Record<string, unknown> | undefined => {
  try {
    const p: unknown = JSON.parse(stdout);
    return isObj(p) && p.ok === true && isObj(p.result) ? p.result : undefined;
  } catch {
    return undefined;
  }
};

/** Orca prints `2026-11-08 09:43:47` in UTC. */
const orcaTime = (v: unknown): number | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : undefined;
};

/** One message id the worker's transcript holds, from `worker-read`. */
export const transcriptMessageId = (stdout: string): string | undefined => {
  const r = json(stdout);
  if (!r || r.source !== "transcript" || r.sourceExact === false) return undefined;
  const t = isObj(r.transcript) ? r.transcript : {};
  const msgs = Array.isArray(t.messages) ? t.messages : [];
  for (const m of msgs) if (isObj(m) && str(m.id)) return str(m.id);
  return undefined;
};

/** Where and when the worker ran, from `worker-show --json --full`. */
export const workerPlace = (stdout: string): { cwd?: string; runId?: string; startedAt?: number } => {
  const r = json(stdout);
  if (!r) return {};
  const terminal = isObj(r.terminal) ? r.terminal : {};
  const dispatch = isObj(r.dispatch) ? r.dispatch : {};
  const cwd = str(terminal.worktreePath);
  const runId = str(dispatch.runId);
  const startedAt = orcaTime(dispatch.dispatchedAt ?? dispatch.createdAt);
  return { ...(cwd ? { cwd } : {}), ...(runId ? { runId } : {}), ...(startedAt ? { startedAt } : {}) };
};

const jsonlIn = async (dir: string, since?: number): Promise<{ path: string; mtime: number }[]> => {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: { path: string; mtime: number }[] = [];
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const path = join(dir, n);
    const s = await stat(path).catch(() => undefined);
    if (!s?.isFile()) continue;
    if (since !== undefined && s.mtimeMs < since) continue;
    out.push({ path, mtime: s.mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
};

const holds = async (path: string, needle: string): Promise<boolean> =>
  (await Bun.file(path).text().catch(() => "")).includes(needle);

/** Find the session file holding `messageId`, the worker's own folder first. */
const findSession = async (projects: string, messageId: string, cwd?: string, since?: number): Promise<string | undefined> => {
  const needle = `"uuid":"${messageId}"`;
  const own = cwd ? join(projects, projectSlug(cwd)) : undefined;
  if (own) for (const f of await jsonlIn(own)) if (await holds(f.path, needle)) return f.path;
  // A file written before the dispatch cannot hold its messages; a minute of
  // slack covers clocks and Orca's second-resolution timestamps.
  const after = since !== undefined ? since - 60_000 : undefined;
  const dirs = await readdir(projects).catch(() => [] as string[]);
  const candidates: { path: string; mtime: number }[] = [];
  for (const d of dirs) {
    const dir = join(projects, d);
    if (dir === own) continue;
    candidates.push(...(await jsonlIn(dir, after)));
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const f of candidates) if (await holds(f.path, needle)) return f.path;
  return undefined;
};

/** Resolve an Orca dispatch to its Claude Code session and transcript files. */
export const resolveWorkerSession = async (
  dispatchId: string,
  deps: TranscriptDeps,
): Promise<WorkerSession | { readonly error: string }> => {
  const projects = deps.projectsDir ?? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  const read = await deps.orca(["orchestration", "worker-read", "--dispatch", dispatchId, "--source", "transcript", "--limit", "1", "--json", "--full"]);
  const messageId = transcriptMessageId(read.stdout);
  if (!messageId) return { error: "Orca has no Claude transcript for that worker (not a claude worker, gone, or Orca is down)" };
  const shown = deps.shown ?? (await deps.orca(["orchestration", "worker-show", "--dispatch", dispatchId, "--json", "--full"])).stdout;
  const place = workerPlace(shown);
  const file = await findSession(projects, messageId, place.cwd, place.startedAt);
  if (!file) return { error: `no transcript under ${projects} holds that worker's messages` };
  const sessionId = file.slice(file.lastIndexOf("/") + 1, -".jsonl".length);
  const subDir = join(file.slice(0, -".jsonl".length), "subagents");
  const subs = (await jsonlIn(subDir)).map((f) => f.path).sort();
  return { dispatchId, sessionId, files: [file, ...subs], ...place };
};

/** Resolve a worker and sum what its transcripts used. */
export const measureWorker = async (
  dispatchId: string,
  deps: TranscriptDeps,
): Promise<(WorkerUsage & { readonly session: WorkerSession }) | { readonly error: string }> => {
  const session = await resolveWorkerSession(dispatchId, deps);
  if ("error" in session) return session;
  const texts = await Promise.all(session.files.map((f) => Bun.file(f).text().catch(() => "")));
  return {
    ...workerUsage(dispatchId, session.sessionId, sumTranscripts(texts)),
    ...(session.runId ? { runId: session.runId } : {}),
    ...(session.startedAt ? { startedAt: session.startedAt } : {}),
    session,
  };
};

/** Dispatch ids a Run holds, from `task-list --run <id> --json`. */
export const runDispatches = (stdout: string): string[] => {
  const r = json(stdout);
  const tasks = r && Array.isArray(r.tasks) ? r.tasks : [];
  const ids: string[] = [];
  for (const t of tasks) {
    const id = isObj(t) ? str(t.dispatchId) : undefined;
    if (id && /^ctx_[A-Za-z0-9_-]+$/.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
};
