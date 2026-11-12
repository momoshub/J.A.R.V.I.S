/**
 * CI-gated review: what the checks of a PR say, and the spec of the watcher
 * that waits for them.
 *
 * `quick-review` looks at CI before anything else. Red is a change request on the
 * spot; green or still running goes on with the review, and a running CI gets
 * a watcher (a row on the watcher's timer, so nothing sleeps in a turn) that
 * settles the PR when the checks stop running. Pure: no I/O, no clock.
 */

/** What the checks of a PR add up to. */
export type CiVerdict =
  /** At least one check failed (even if others still run). */
  | "red"
  /** Nothing failed and something is still running or queued. */
  | "running"
  /** Everything finished well, or the PR has no checks at all. */
  | "green";

export type CiStatus = {
  readonly verdict: CiVerdict;
  /** Names of the failed checks, in the order GitHub lists them. */
  readonly failed: readonly string[];
};

export type PrState = "OPEN" | "MERGED" | "CLOSED";

/** One entry of `statusCheckRollup`, as `gh pr view --json` prints it. */
export type RollupEntry = {
  readonly name?: unknown;
  readonly context?: unknown;
  readonly status?: unknown;
  readonly conclusion?: unknown;
  readonly state?: unknown;
  readonly workflowName?: unknown;
  readonly startedAt?: unknown;
  readonly completedAt?: unknown;
};

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const FAILED_STATES = new Set(["FAILURE", "ERROR"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);

const upper = (v: unknown): string => (typeof v === "string" ? v.toUpperCase() : "");

const stamp = (e: RollupEntry): string =>
  typeof e.startedAt === "string" ? e.startedAt : typeof e.completedAt === "string" ? e.completedAt : "";

/**
 * The rollup lists every run on the head commit, including ones a later run
 * replaced (a cancelled run beside the re-run that passed). Only the newest
 * entry of each check (workflow + name) counts; on a tie the later one listed.
 */
const latestPerCheck = (rollup: readonly RollupEntry[]): RollupEntry[] => {
  const newest = new Map<string, RollupEntry>();
  rollup.forEach((e, i) => {
    const name = typeof e.name === "string" && e.name ? e.name : typeof e.context === "string" ? e.context : `#${i}`;
    const key = `${typeof e.workflowName === "string" ? e.workflowName : ""}|${name}`;
    const seen = newest.get(key);
    if (!seen || stamp(e) >= stamp(seen)) newest.set(key, e);
  });
  return [...newest.values()];
};

/**
 * Classify a rollup. A check run carries `status` + `conclusion`, a commit
 * status carries `state`. Failed beats running: a PR with one red check and
 * ten still going is red already, and waiting for the rest only delays the
 * news. A skipped, neutral or stale check is not a failure.
 */
export const ciStatusOf = (all: readonly RollupEntry[]): CiStatus => {
  const failed: string[] = [];
  let running = false;
  for (const e of latestPerCheck(all)) {
    const name = typeof e.name === "string" && e.name ? e.name : typeof e.context === "string" ? e.context : "check";
    const conclusion = upper(e.conclusion);
    const status = upper(e.status);
    const state = upper(e.state);
    if (FAILED_CONCLUSIONS.has(conclusion) || FAILED_STATES.has(state)) {
      failed.push(name);
    } else if (PENDING_STATES.has(state) || (status !== "" && status !== "COMPLETED")) {
      running = true;
    }
  }
  if (failed.length > 0) return { verdict: "red", failed };
  return { verdict: running ? "running" : "green", failed: [] };
};

export const asPrState = (v: unknown): PrState | undefined => {
  const s = upper(v);
  return s === "OPEN" || s === "MERGED" || s === "CLOSED" ? s : undefined;
};

/** The failing checks, for a thread line or a review body. */
export const failedList = (failed: readonly string[], max = 5): string => {
  if (failed.length === 0) return "a check failed";
  const shown = failed.slice(0, max).map((n) => `\`${n}\``).join(", ");
  return failed.length > max ? `${shown} and ${failed.length - max} more` : shown;
};

/** Body of the change request submitted because CI is red. */
export const redChangesBody = (failed: readonly string[], when: "before" | "after"): string =>
  `requested changes: CI is ${when === "before" ? "red" : "red now"} (failing: ${failed.slice(0, 8).join(", ") || "a check"})`;

/** How a watcher poll should end, given what the PR looks like now. */
export type GateAction =
  /** Nothing to do yet: poll again later. */
  | { readonly do: "wait" }
  /** The PR is merged or closed: stop, touch nothing. */
  | { readonly do: "stop"; readonly why: "merged" | "closed" }
  /** CI went red: request changes, then stop. */
  | { readonly do: "request-changes" }
  /** CI is green and the review released the approval: approve, then stop. */
  | { readonly do: "approve" }
  /** CI is green and there is nothing left for the watcher to do. */
  | { readonly do: "done" };

export type GateSpec = {
  /** The PR the gate guards. */
  readonly url: string;
  /** What the run is on: first approves before the review, after approves once it is clean. */
  readonly policy: "approve-first" | "approve-after";
};

/**
 * Where the review of a run is, as far as the watcher can tell:
 * `reviewing` - still being written; `released` - ended, the approval is the
 * watcher's; `settled` - the command decided the approval itself (or the
 * review failed), the watcher only keeps an eye out for red. Undefined means
 * unknown (the process restarted), which is treated like `reviewing`.
 */
export type ReviewPhase = "reviewing" | "released" | "settled";

/**
 * What a poll should do. Only `approve-after` cares about the phase: it must
 * never approve while the review is still being written.
 */
export const gateAction = (
  spec: GateSpec,
  now: { readonly state: PrState; readonly ci: CiStatus },
  phase: ReviewPhase | undefined,
): GateAction => {
  if (now.state !== "OPEN") return { do: "stop", why: now.state === "MERGED" ? "merged" : "closed" };
  if (now.ci.verdict === "red") return { do: "request-changes" };
  if (now.ci.verdict === "running") return { do: "wait" };
  // Green. Approve-first approved up front, so green has nothing to add.
  if (spec.policy === "approve-first") return { do: "done" };
  if (phase === "settled") return { do: "done" };
  return phase === "released" ? { do: "approve" } : { do: "wait" };
};

/** A watch row is a CI gate when its check starts with this; the rest is the spec as JSON. */
export const GATE_PREFIX = "ci-gate:";

export const encodeGate = (spec: GateSpec): string => `${GATE_PREFIX}${JSON.stringify(spec)}`;

export const decodeGate = (check: string): GateSpec | undefined => {
  if (!check.startsWith(GATE_PREFIX)) return undefined;
  try {
    const raw: unknown = JSON.parse(check.slice(GATE_PREFIX.length));
    if (typeof raw !== "object" || raw === null) return undefined;
    const { url, policy } = raw as { url?: unknown; policy?: unknown };
    if (typeof url !== "string" || !url) return undefined;
    if (policy !== "approve-first" && policy !== "approve-after") return undefined;
    return { url, policy };
  } catch {
    return undefined;
  }
};

/** Poll cadence and ceiling of a gate: CI of a normal PR is done well inside the hour. */
export const GATE_EVERY_MS = 60_000;
export const GATE_DEADLINE_MS = 60 * 60_000;

/** The `note` of a gate's watch row, for `watch list` and `mindful`. */
export const gateNote = (spec: GateSpec): string =>
  `CI gate (${spec.policy === "approve-first" ? "approve first" : "approve after"}) on ${spec.url}`;
