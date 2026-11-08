/**
 * `worker-cost`: what an Orca worker, or a whole Run, used and cost.
 *
 * A worker is measured live from its transcript when Orca still knows it, and
 * the measurement is stored; when Orca has forgotten it (or is down) the last
 * stored one answers instead, and says when it was taken. A Run is every
 * worker `task-list` names, each measured the same way, plus the total.
 */
import { usageSummary, usd, workerUsage, type ModelUsage, type WorkerUsage } from "../domain/workerUsage.ts";
import type { WorkerUsageRepo } from "../infrastructure/db/workerUsageRepo.ts";

export type WorkerUsagePort = {
  /** Resolve the worker's session and sum its transcript now. */
  measure: (dispatchId: string) => Promise<WorkerUsage | { readonly error: string }>;
  /** Dispatch ids in a Run, from Orca; empty when Orca cannot say. */
  dispatchesOf: (runId: string) => Promise<string[]>;
  repo: WorkerUsageRepo;
};

const DISPATCH = /^ctx_[A-Za-z0-9_-]+$/;
const RUN = /^run_[A-Za-z0-9_-]+$/;

const ago = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

type Measured = { readonly usage: WorkerUsage; readonly note: string } | { readonly error: string };

const measureOne = async (id: string, port: WorkerUsagePort, now: number): Promise<Measured> => {
  const live = await port.measure(id).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  if (!("error" in live)) {
    port.repo.save(live, now);
    return { usage: live, note: "" };
  }
  const stored = port.repo.get(id);
  if (stored) return { usage: stored, note: ` (measured ${ago(now - stored.measuredAt)}; ${live.error})` };
  return { error: live.error };
};

/** The command's answer for a `ctx_...` or `run_...` target. */
export const workerCostReport = async (target: string, port: WorkerUsagePort, now: number): Promise<string> => {
  if (DISPATCH.test(target)) {
    const m = await measureOne(target, port, now);
    if ("error" in m) return `I cannot tell what ${target} used: ${m.error}.`;
    return `Orca worker ${target} used ${usageSummary(m.usage)}, Claude session ${m.usage.sessionId}${m.note}. List price: nobody is invoiced this on a subscription.`;
  }
  if (!RUN.test(target)) return "Give me a dispatch id (`ctx_...`, what `worker-start` printed) or a Run id (`run_...`).";

  // Orca's list first; what was stored for the Run covers workers Orca forgot.
  const ids = [...(await port.dispatchesOf(target).catch(() => [] as string[]))];
  for (const s of port.repo.inRun(target)) if (!ids.includes(s.dispatchId)) ids.push(s.dispatchId);
  if (ids.length === 0) return `I know of no workers in ${target}.`;

  const lines: string[] = [];
  const all: ModelUsage[] = [];
  for (const id of ids) {
    const m = await measureOne(id, port, now);
    if ("error" in m) {
      lines.push(`- ${id}: could not tell (${m.error})`);
      continue;
    }
    all.push(...m.usage.models);
    lines.push(`- ${id}: ${usageSummary(m.usage)}${m.note}`);
  }
  // Merge per model so the total is priced exactly like each worker.
  const merged = new Map<string, ModelUsage>();
  for (const u of all) {
    const p = merged.get(u.model);
    merged.set(
      u.model,
      p
        ? {
            model: u.model,
            messages: p.messages + u.messages,
            input: p.input + u.input,
            output: p.output + u.output,
            cacheWrite5m: p.cacheWrite5m + u.cacheWrite5m,
            cacheWrite1h: p.cacheWrite1h + u.cacheWrite1h,
            cacheRead: p.cacheRead + u.cacheRead,
          }
        : u,
    );
  }
  const total = workerUsage(target, "", [...merged.values()]);
  const head =
    total.costUsd === undefined
      ? `Run ${target}, ${ids.length} ${ids.length === 1 ? "worker" : "workers"}: ${usageSummary(total)}.`
      : `Run ${target}, ${ids.length} ${ids.length === 1 ? "worker" : "workers"}: ${usd(total.costUsd)} at list price in all - ${usageSummary(total)}.`;
  return [head, ...lines].join("\n");
};
