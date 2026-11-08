#!/usr/bin/env bun
//
// Has this Orca worker finished, died, or stopped to wait for input?
//
//   orca-worker-wait.ts <dispatch-id>
//
// Exits 0 and prints `orca worker <id> finished|died|waiting: <detail>` the
// moment one of the three is true, 1 while it is still running, and 2 when
// Orca could not say (down, timed out, an answer that is not a worker
// record) - which a watch keeps polling rather than reading as a death.
// The reading itself is `orcaWorkerEvent` in src/domain/watch.ts; the hand-back
// turn reads the printed line back to say which of the three happened.
import { orcaWorkerEvent, workerEventLine } from "../src/domain/watch.ts";

const TIMEOUT_MS = 20_000;

const id = process.argv[2] ?? "";
if (!/^ctx_[A-Za-z0-9_-]+$/.test(id)) {
  console.error("usage: orca-worker-wait.ts <dispatch-id>");
  process.exit(2);
}

const proc = Bun.spawn(["orca", "orchestration", "worker-show", "--dispatch", id, "--json", "--full"], {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});
const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
// `worker-show` exits 1 on `dispatch_not_found` but still prints JSON, so the
// exit code is not the answer - the record is.
const out = await new Response(proc.stdout).text();
await proc.exited;
clearTimeout(timer);

const ev = orcaWorkerEvent(out);
if (ev.kind === "running") {
  console.log(`orca worker ${id} still running`);
  process.exit(1);
}
if (ev.kind === "unknown") {
  console.log(`orca worker ${id}: could not tell (${ev.detail})`);
  process.exit(2);
}
console.log(workerEventLine(id, ev));
process.exit(0);
