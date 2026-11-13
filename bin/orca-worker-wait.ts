#!/usr/bin/env bun
//
// Has this Orca worker finished, died, or stopped to wait for input?
//
//   orca-worker-wait.ts <dispatch-id> [--past-wait[=<armed-at-ms>]]
//
// Exits 0 and prints `orca worker <id> finished|died|waiting: <detail>` the
// moment one of the three is true, 1 while it is still running, and 2 when
// Orca could not say (down, timed out, an answer that is not a worker
// record) - which a watch keeps polling rather than reading as a death.
// `orca` itself missing or failing to start exits 127, which the watcher
// counts as a broken check and reports, instead of polling it for hours.
// A worker silent at its prompt for 15 minutes with no report counts as
// waiting too (`WORKER_IDLE_MS`); the clock is read here, not in the domain.
// `--past-wait=<ms>` ignores the wait for input it was set for (a worker already
// known to be parked on a person's answer), but not idle: once the worker's
// output has moved past <ms> and then gone silent for `WORKER_IDLE_MS`, it
// still fires. A bare `--past-wait` (watch rows stored before the arm time
// existed) keeps the old behaviour: no output can pass it, so it never fires
// idle. The same rule covers a watch re-armed after an idle hand-back: it stays
// quiet until the worker has produced new output.
// The reading itself is `orcaWorkerEvent` in src/domain/watch.ts; the hand-back
// turn reads the printed line back to say which of the three happened.
// A worker that finished or died also gets `orca worker <id> usage <json>`:
// the tokens its Claude transcript used, priced (src/domain/workerUsage.ts),
// which the hand-back names and the watcher stores. Best effort and bounded,
// so a missing transcript never holds up the hand-back.
import { orcaWorkerEvent, workerEventLine } from "../src/domain/watch.ts";
import { workerUsageLine } from "../src/domain/workerUsage.ts";
import { measureWorker } from "../src/infrastructure/system/workerTranscript.ts";
import { createOrcaCli } from "../src/infrastructure/system/orcaTerminal.ts";
import { logAndIgnore } from "../src/application/ignoredError.ts";

const TIMEOUT_MS = 15_000;
/** The whole usage step; the watcher kills a check at 30s (`CHECK_TIMEOUT_MS`). */
const USAGE_BUDGET_MS = 10_000;

const id = process.argv[2] ?? "";
const pastWaitArg = process.argv.slice(3).find((a) => a === "--past-wait" || a.startsWith("--past-wait="));
const armedAt = pastWaitArg?.split("=")[1];
const pastWaitAt = pastWaitArg === undefined ? undefined : armedAt !== undefined && /^\d+$/.test(armedAt) ? Number(armedAt) : Number.MAX_SAFE_INTEGER;
if (!/^ctx_[A-Za-z0-9_-]+$/.test(id)) {
  console.error("usage: orca-worker-wait.ts <dispatch-id> [--past-wait[=<armed-at-ms>]]");
  process.exit(2);
}

const orca = process.env.ORCA_BIN || "orca";
let out = "";
try {
  const proc = Bun.spawn([orca, "orchestration", "worker-show", "--dispatch", id, "--json", "--full"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  // `worker-show` exits 1 on `dispatch_not_found` but still prints JSON, so the
  // exit code is not the answer - the record is.
  out = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
} catch (e) {
  console.log(`could not run ${orca}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(127);
}

const ev = orcaWorkerEvent(out, Date.now(), pastWaitAt);
if (ev.kind === "running") {
  console.log(`orca worker ${id} still running`);
  process.exit(1);
}
if (ev.kind === "unknown") {
  console.log(`orca worker ${id}: could not tell (${ev.detail})`);
  process.exit(2);
}
console.log(workerEventLine(id, ev));
if (ev.kind !== "waiting") {
  const usage = await Promise.race([
    measureWorker(id, { orca: createOrcaCli(orca, USAGE_BUDGET_MS), shown: out }).catch(logAndIgnore("orca worker usage")),
    new Promise<undefined>((r) => setTimeout(() => r(undefined), USAGE_BUDGET_MS)),
  ]);
  if (usage && !("error" in usage)) console.log(workerUsageLine(usage));
}
process.exit(0);
