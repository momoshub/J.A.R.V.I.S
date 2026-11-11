/**
 * CI gate of a review: the actions on a PR that depend on its checks, and the
 * poll the watcher runs for a PR whose CI is still going.
 *
 * Nothing here sleeps in a turn. A running CI gets a row on the watcher's
 * timer (`start`), the watcher calls `step` once a minute, and every action is
 * idempotent against GitHub itself: a change request is skipped when ours is
 * already the latest review, an approval likewise, and nothing is requested or
 * approved on a PR that is merged or closed.
 *
 * What lives only in memory is whether the review of a run is still being
 * written (`approve-after` must not approve before it ends). A restart loses
 * it, and the safe answer to "unknown" is to wait out the deadline and not
 * approve.
 */

import {
  decodeGate,
  encodeGate,
  failedList,
  gateAction,
  gateNote,
  GATE_DEADLINE_MS,
  GATE_EVERY_MS,
  redChangesBody,
  type GateSpec,
  type ReviewPhase,
} from "../domain/ciGate.ts";
import type { Watch, WatchRepo } from "../infrastructure/db/watchRepo.ts";
import type { ApproveResult, GitHubPort, PrSnapshot } from "./github.ts";
import type { Clock } from "./ports.ts";

export type CiGateDeps = {
  github: GitHubPort;
  watches?: WatchRepo;
  clock: Clock;
  /** Say something in the review's thread. Without it the gate acts silently. */
  say?: (channelId: string, text: string, threadTs: string) => Promise<void>;
};

/** Where a gate answers: the thread of the review that started it. */
export type GateWhere = {
  readonly channelId: string;
  readonly threadTs: string;
  readonly slackUserId: string;
};

export type ChangeResult = "submitted" | "already" | "closed" | { readonly error: string };
export type ApprovalResult = "approved" | "already" | "blocked" | "closed" | { readonly error: string };

export type CiGate = {
  /** The PR as it is now, or undefined when GitHub cannot say (then there is no gate). */
  inspect: (url: string) => Promise<PrSnapshot | undefined>;
  /** Request changes because CI is red. Idempotent; never on a merged or closed PR. */
  requestChanges: (url: string, snap: PrSnapshot, when: "before" | "after") => Promise<ChangeResult>;
  /** Approve. Idempotent; never over a change request, never on a merged or closed PR. */
  approve: (url: string, snap: PrSnapshot) => Promise<ApprovalResult>;
  /** Watch the CI of a PR on the watcher's timer. False when no watch can be kept. */
  start: (spec: GateSpec, where: GateWhere) => boolean;
  /** The review ended and the approval is the watcher's. True when a watcher is alive to take it. */
  release: (url: string) => boolean;
  /** The command decided the approval itself, or the review failed: the watcher only watches for red. */
  handled: (url: string) => void;
  /** One poll of a gate row. */
  step: (spec: GateSpec, where: GateWhere) => Promise<"pending" | "done">;
  /** A gate row ended without settling the PR. */
  stop: (spec: GateSpec, where: GateWhere, why: "deadline" | "errors") => Promise<void>;
};

export const createCiGate = (deps: CiGateDeps): CiGate => {
  const phases = new Map<string, ReviewPhase>();

  const say = async (where: GateWhere, text: string): Promise<void> => {
    if (!deps.say || !where.channelId || !where.threadTs) return;
    await deps.say(where.channelId, text, where.threadTs).catch(() => undefined);
  };

  const failure = (res: ApproveResult): { readonly error: string } =>
    res.ok ? { error: "unknown" } : { error: res.error };

  const requestChanges: CiGate["requestChanges"] = async (url, snap, when) => {
    if (snap.state !== "OPEN") return "closed";
    if (snap.mine === "CHANGES_REQUESTED") return "already";
    if (!deps.github.requestChanges) return { error: "no way to request changes here" };
    const res = await deps.github.requestChanges(url, redChangesBody(snap.ci.failed, when));
    return res.ok ? "submitted" : failure(res);
  };

  const approve: CiGate["approve"] = async (url, snap) => {
    if (snap.state !== "OPEN") return "closed";
    if (snap.decision === "CHANGES_REQUESTED" || snap.mine === "CHANGES_REQUESTED") return "blocked";
    if (snap.mine === "APPROVED") return "already";
    const res = await deps.github.approve(url);
    return res.ok ? "approved" : failure(res);
  };

  const rows = (url: string): Watch[] =>
    (deps.watches?.waiting(200) ?? []).filter((w) => decodeGate(w.check)?.url === url);

  return {
    inspect: async (url) => deps.github.snapshot?.(url),
    requestChanges,
    approve,

    start: (spec, where) => {
      if (!deps.watches) return false;
      phases.set(spec.url, "reviewing");
      const now = deps.clock();
      const alive = rows(spec.url);
      // One watcher per PR. The same one is kept; a different policy replaces it.
      if (alive.some((w) => decodeGate(w.check)?.policy === spec.policy)) return true;
      for (const w of alive) deps.watches.settle(w.id, "cancelled", now);
      deps.watches.add(
        {
          channelId: where.channelId,
          threadTs: where.threadTs,
          slackUserId: where.slackUserId,
          note: gateNote(spec),
          check: encodeGate(spec),
          everyMs: GATE_EVERY_MS,
          deadlineAt: now + GATE_DEADLINE_MS,
          createdAt: now,
        },
        now,
      );
      return true;
    },

    release: (url) => {
      if (phases.has(url)) phases.set(url, "released");
      return rows(url).length > 0;
    },

    handled: (url) => {
      if (phases.has(url)) phases.set(url, "settled");
    },

    step: async (spec, where) => {
      const snap = await deps.github.snapshot?.(spec.url);
      if (!snap) return "pending"; // unreadable right now: the deadline bounds it
      const action = gateAction(spec, snap, phases.get(spec.url));
      if (action.do !== "wait") phases.delete(spec.url);
      switch (action.do) {
        case "wait":
          return "pending";
        case "stop":
          await say(where, `🛑 ${spec.url} is ${action.why} - stopped watching its CI`);
          return "done";
        case "request-changes": {
          const res = await requestChanges(spec.url, snap, "after");
          if (res === "submitted") {
            await say(where, `⚠️ CI went red on ${spec.url} (${failedList(snap.ci.failed)}) - requested changes`);
          } else if (typeof res === "object") {
            await say(where, `⚠️ CI is red on ${spec.url} but I could not request changes - ${res.error}`);
          }
          return "done";
        }
        case "approve": {
          const res = await approve(spec.url, snap);
          if (res === "approved") await say(where, `✅ approved ${spec.url} - the review came back clean and CI is green`);
          else if (res === "blocked") await say(where, `🚫 not approving ${spec.url} - changes are requested`);
          else if (typeof res === "object") await say(where, `⚠️ could not approve ${spec.url} - ${res.error}`);
          return "done";
        }
        case "done":
          return "done";
      }
    },

    stop: async (spec, where, why) => {
      phases.delete(spec.url);
      const what = why === "deadline" ? "CI did not settle in time" : "I could not read the CI";
      await say(
        where,
        spec.policy === "approve-after"
          ? `⏱️ ${what} on ${spec.url} - not approving, nothing was changed`
          : `⏱️ ${what} on ${spec.url} - stopped watching it`,
      );
    },
  };
};
