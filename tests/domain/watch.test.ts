import { describe, expect, test } from "bun:test";
import { workerUsage, workerUsageLine } from "../../src/domain/workerUsage.ts";
import {
  DEFAULT_EVERY_MS,
  gaveUpMessage,
  humanDuration,
  MAX_DEADLINE_MS,
  MIN_EVERY_MS,
  parseDuration,
  parseWatchArgs,
  readyMessage,
  builtinCheck,
  shellQuote,
  orcaWorkerEvent,
  workerEventLine,
  WORKER_EVERY_MS,
  WORKER_DEADLINE_MS,
} from "../../src/domain/watch.ts";

describe("parseDuration", () => {
  test("the shapes people type", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("2m")).toBe(120_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("5")).toBe(300_000); // a bare number is minutes
    expect(parseDuration("90 sec")).toBe(90_000);
  });

  test("nonsense is nonsense", () => {
    expect(parseDuration("soon")).toBeUndefined();
    expect(parseDuration("0m")).toBeUndefined();
    expect(parseDuration("-5m")).toBeUndefined();
    expect(parseDuration("")).toBeUndefined();
  });
});

describe("parseWatchArgs", () => {
  test("the real case: poll a build, then promote", () => {
    const a = parseWatchArgs(
      "--every 1m --until 45m promote be US then SG -- gh run view 123 --json status -q .status | grep -q completed",
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.everyMs).toBe(60_000);
    expect(a.deadlineMs).toBe(45 * 60_000);
    expect(a.note).toBe("promote be US then SG");
    // the predicate survives its pipes and flags intact
    expect(a.check).toBe("gh run view 123 --json status -q .status | grep -q completed");
  });

  test("no predicate is a plain timer, which is still useful", () => {
    const a = parseWatchArgs("--until 10m check the build again");
    expect(a.ok && a.check).toBe("");
    expect(a.ok && a.note).toBe("check the build again");
  });

  test("defaults are sane when nothing is said", () => {
    const a = parseWatchArgs("promote it");
    expect(a.ok && a.everyMs).toBe(DEFAULT_EVERY_MS);
  });

  test("it refuses to spin", () => {
    const a = parseWatchArgs("--every 1s do it");
    expect(a.ok).toBe(false);
    expect(!a.ok && a.error).toContain("fastest");
  });

  test("it refuses to wait forever", () => {
    const a = parseWatchArgs("--until 48h do it");
    expect(a.ok).toBe(false);
    expect(!a.ok && a.error).toContain("at most");
  });

  test("checking once after giving up is caught", () => {
    const a = parseWatchArgs("--every 30m --until 5m do it");
    expect(a.ok).toBe(false);
    expect(!a.ok && a.error).toContain("already given up");
  });

  test("a watch with nothing to do afterwards is pointless", () => {
    expect(parseWatchArgs("--every 1m").ok).toBe(false);
    expect(parseWatchArgs("-- gh run view 1").ok).toBe(false);
  });

  test("a dangling separator is refused rather than silently dropped", () => {
    expect(parseWatchArgs("do the thing --").ok).toBe(false);
  });

  test("a bad duration is named, not ignored", () => {
    const a = parseWatchArgs("--every soon do it");
    expect(!a.ok && a.error).toContain("--every");
  });
});

describe("the messages a watch sends back", () => {
  test("ready tells it to carry on, not to start over", () => {
    const m = readyMessage("promote be US then SG", 600_000, "status\ncompleted");
    expect(m).toContain("do not start it over");
    expect(m).toContain("promote be US then SG");
    expect(m).toContain("10m");
    expect(m).toContain("completed");
  });

  test("ready says DO IT, because handing the work back is the failure", () => {
    // the turn that set the watch was already asking a human to run the
    // promote; forty minutes later that person is no longer reading
    const m = readyMessage("promote be US then SG", 600_000);
    expect(m).toContain("Do it yourself, now");
    expect(m).toContain("do not ask whether to go ahead");
    expect(m).toContain("do not hand the steps back");
    // but a genuine blocker is still reportable
    expect(m).toContain("what blocked it");
  });

  test("giving up is explicit that nothing was done", () => {
    const m = gaveUpMessage("promote it", 2_700_000, "the build never finished");
    expect(m).toContain("I have not done it");
    expect(m).toContain("45m");
  });
});

describe("humanDuration", () => {
  test("round trips the way it reads", () => {
    expect(humanDuration(MIN_EVERY_MS)).toBe("15s");
    expect(humanDuration(600_000)).toBe("10m");
    expect(humanDuration(MAX_DEADLINE_MS)).toBe("6h00m");
  });
});

describe("named waits", () => {
  const PR = "https://github.com/acme/acme-api/pull/14538";

  test("a PR it opened: merged", () => {
    const r = builtinCheck("pr", PR);
    expect("check" in r && r.check).toContain("gh pr view");
    expect("check" in r && r.check).toContain("grep -qx MERGED");
  });

  test("CI: waits for it to STOP being pending, so a failure is heard too", () => {
    // measured: gh pr checks exits 8 while pending, 1 on failure, 0 when green
    const r = builtinCheck("checks", PR);
    expect("check" in r && r.check).toContain("-ne 8");
  });

  test("an answer owed by somebody else", () => {
    const r = builtinCheck("reply", "", {
      slackWaitScript: "/x/slack-wait.sh",
      channel: "C1",
      threadTs: "9.9",
      afterTs: "1793783000.000000",
      from: "U2",
    });
    expect("check" in r && r.check).toBe("/x/slack-wait.sh 'C1' '9.9' '1793783000.000000' 'U2'");
  });

  test("a deployment, once there is something to curl", () => {
    const r = builtinCheck("url", "https://api.test/health");
    expect("check" in r && r.check).toContain("curl -sfS");
  });

  test("a target that is not what the kind needs is refused, not guessed", () => {
    expect("error" in builtinCheck("pr", "the big one")).toBe(true);
    expect("error" in builtinCheck("url", "not-a-url")).toBe(true);
    expect("error" in builtinCheck("reply", "", {})).toBe(true);
  });

  test("a url with a shell character cannot become a second command", () => {
    const r = builtinCheck("url", "https://x.test/?a=1&b=2; rm -rf /");
    expect("check" in r && r.check).toContain("'https://x.test/?a=1&b=2; rm -rf /'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("parsing a named wait", () => {
  test("kind, target, and what to do after", () => {
    const a = parseWatchArgs("pr https://github.com/o/r/pull/1 promote it");
    expect(a.ok && a.kind).toBe("pr");
    expect(a.ok && a.target).toBe("https://github.com/o/r/pull/1");
    expect(a.ok && a.note).toBe("promote it");
  });

  test("Slack's link wrapping does not reach the target", () => {
    const a = parseWatchArgs("pr <https://github.com/o/r/pull/1|o/r#1> promote it");
    expect(a.ok && a.target).toBe("https://github.com/o/r/pull/1");
  });

  test("waiting on one person in particular", () => {
    const a = parseWatchArgs("reply https://x.slack.com/archives/C1/p1 from <@U2> use what they say");
    expect(a.ok && a.kind).toBe("reply");
    expect(a.ok && a.from).toBe("U2");
    expect(a.ok && a.note).toBe("use what they say");
  });

  test("a kind word in the middle of a sentence is just a word", () => {
    // "watch the pr" must not silently become a pull request watch
    const a = parseWatchArgs("tell me when the pr lands -- true");
    expect(a.ok && a.kind).toBeUndefined();
    expect(a.ok && a.note).toBe("tell me when the pr lands");
  });

  test("flags still work alongside a named wait", () => {
    const a = parseWatchArgs("--every 2m --until 1h checks https://github.com/o/r/pull/9 report CI");
    expect(a.ok && a.kind).toBe("checks");
    expect(a.ok && a.everyMs).toBe(120_000);
  });
});

describe("watch worker", () => {
  const WAIT = ["/usr/bin/bun", "/repo/bin/orca-worker-wait.ts"];

  test("parses a dispatch id, with worker-sized defaults", () => {
    const a = parseWatchArgs("worker ctx_b3290a07f606 merge its PR");
    expect(a.ok && a.kind).toBe("worker");
    expect(a.ok && a.target).toBe("ctx_b3290a07f606");
    expect(a.ok && a.note).toBe("merge its PR");
    expect(a.ok && a.everyMs).toBe(WORKER_EVERY_MS);
    expect(a.ok && a.deadlineMs).toBe(WORKER_DEADLINE_MS);
    expect(WORKER_EVERY_MS).toBe(3 * 60_000);
    expect(WORKER_DEADLINE_MS).toBe(3 * 3_600_000);
  });

  test("flags still win over the worker defaults", () => {
    const a = parseWatchArgs("--every 1m --until 5h worker ctx_1 go");
    expect(a.ok && a.everyMs).toBe(60_000);
    expect(a.ok && a.deadlineMs).toBe(5 * 3_600_000);
  });

  test("a short --until with no --every looks once at the end instead of refusing", () => {
    const a = parseWatchArgs("worker ctx_1 --until 2m go");
    expect(a.ok && a.everyMs).toBe(120_000);
    // other kinds keep their minute default
    const b = parseWatchArgs("pr https://github.com/o/r/pull/1 go");
    expect(b.ok && b.everyMs).toBe(DEFAULT_EVERY_MS);
  });

  test("builds a quoted call to the helper", () => {
    const r = builtinCheck("worker", "ctx_abc123", { orcaWorkerWait: WAIT });
    expect("check" in r && r.check).toBe("'/usr/bin/bun' '/repo/bin/orca-worker-wait.ts' 'ctx_abc123'");
  });

  test("--past-wait is kept for a worker and passed to the helper", () => {
    const a = parseWatchArgs("worker ctx_1 --past-wait merge it");
    expect(a.ok && a.pastWait).toBe(true);
    expect(a.ok && a.note).toBe("merge it");
    const r = builtinCheck("worker", "ctx_1", { orcaWorkerWait: WAIT, pastWait: true });
    expect("check" in r && r.check).toEndWith("'ctx_1' '--past-wait'");
    // only a worker knows the flag
    const p = parseWatchArgs("pr https://github.com/o/r/pull/1 --past-wait go");
    expect(p.ok && p.pastWait).toBeUndefined();
  });

  test("refuses anything that is not a dispatch id, or no helper", () => {
    expect("error" in builtinCheck("worker", "ctx_1; rm -rf /", { orcaWorkerWait: WAIT })).toBe(true);
    expect("error" in builtinCheck("worker", "task_123", { orcaWorkerWait: WAIT })).toBe(true);
    expect("error" in builtinCheck("worker", "ctx_1", {})).toBe(true);
  });
});

describe("orcaWorkerEvent", () => {
  const full = (projection: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ ok: true, result: { dispatch: { runId: "run_1" }, projection, observation: { agentWait: null }, ...extra } });

  test("an outcome means finished, even though the process has exited", () => {
    const ev = orcaWorkerEvent(full({ outcome: "succeeded", liveness: { verdict: "exited" }, attention: { categories: ["root_completion"] } }));
    expect(ev).toEqual({ kind: "finished", detail: "outcome succeeded, run run_1" });
    expect(orcaWorkerEvent(full({ outcome: "failed", liveness: { verdict: "exited" } })).kind).toBe("finished");
  });

  test("still in progress and live is running", () => {
    expect(orcaWorkerEvent(full({ outcome: "in_progress", liveness: { verdict: "live" }, attention: { categories: [] } })).kind).toBe(
      "running",
    );
  });

  test("an input attention category or an agent wait is waiting", () => {
    const a = orcaWorkerEvent(full({ outcome: "in_progress", liveness: { verdict: "live" }, attention: { categories: ["input_required"] } }));
    expect(a.kind).toBe("waiting");
    // Orca's requires-action set: a pending approval parks a worker just the same
    expect(orcaWorkerEvent(full({ outcome: "in_progress", liveness: { verdict: "live" }, attention: { categories: ["approval"] } })).kind).toBe("waiting");
    const b = orcaWorkerEvent(
      JSON.stringify({
        ok: true,
        result: { projection: { outcome: "in_progress", liveness: { verdict: "live" } }, observation: { agentWait: { prompt: "Allow edit?" } } },
      }),
    );
    expect(b).toEqual({ kind: "waiting", detail: "Allow edit?" });
  });

  test("no outcome and not live is died", () => {
    const ev = orcaWorkerEvent(full({ outcome: "in_progress", liveness: { verdict: "exited" } }));
    expect(ev.kind).toBe("died");
    expect(orcaWorkerEvent(JSON.stringify({ ok: false, error: { code: "dispatch_not_found" } })).kind).toBe("died");
  });

  test("liveness Orca could not prove is not a death", () => {
    expect(orcaWorkerEvent(full({ outcome: "in_progress", liveness: { verdict: "unverifiable" } })).kind).toBe("running");
    // nor is an outcome Orca could not derive: it is not a finish either
    expect(orcaWorkerEvent(full({ outcome: "outcome_unknown", liveness: { verdict: "unverifiable" } })).kind).toBe("running");
  });

  test("a worker that ended without reporting died, it did not finish", () => {
    // Orca: "execution finished without an accepted worker report"; its task is left blocked
    const gone = orcaWorkerEvent(full({ outcome: "finished_unverified", liveness: { verdict: "exited" } }));
    expect(gone).toEqual({ kind: "died", detail: "ended without reporting (finished_unverified), task left blocked, run run_1" });
    // turn over but the pane still open: just as stuck, nothing will report
    expect(orcaWorkerEvent(full({ outcome: "finished_unverified", liveness: { verdict: "live" } })).kind).toBe("died");
    // but one that ended its turn on an `ask` is waiting for the answer: orcad raises
    // `input` for its pending question and `approval` for the task's open decision gate
    expect(
      orcaWorkerEvent(full({ outcome: "finished_unverified", liveness: { verdict: "live" }, attention: { categories: ["input", "approval"] } })).kind,
    ).toBe("waiting");
    expect(
      orcaWorkerEvent(full({ outcome: "finished_unverified", liveness: { verdict: "exited" }, attention: { categories: ["approval"] } })).kind,
    ).toBe("waiting");
  });

  test("a stopped worker whose task is blocked and terminal is gone died, though Orca says outcome failed", () => {
    // the shape of a real worker-show (ctx_6f407496bffb, its task left blocked)
    const stopped = JSON.stringify({
      ok: true,
      result: {
        dispatch: { runId: "run_0e4", status: "failed", lastFailure: "stopped" },
        worker: { state: "stopped" },
        projection: {
          runId: "run_0e4",
          stage: { worker: "stopped", dispatch: "failed", detail: "process_stopped" },
          outcome: "failed",
          liveness: { verdict: "exited", source: "resource_release" },
          resource: { state: "released", terminalState: "released" },
          attention: { categories: ["failure"], requiresAction: true },
        },
        observation: { status: "exited", exactWorker: true },
      },
    });
    expect(orcaWorkerEvent(stopped)).toEqual({ kind: "died", detail: "stopped without reporting, task left blocked, run run_0e4" });
    // abandoned the same way
    expect(orcaWorkerEvent(full({ outcome: "failed", liveness: { verdict: "exited" } }, { dispatch: { lastFailure: "abandoned" } })).kind).toBe(
      "died",
    );
    // a worker that REPORTED failure is still finished: lastFailure is its report
    const reported = full(
      { outcome: "failed", liveness: { verdict: "exited" } },
      { worker: { state: "failed" }, dispatch: { runId: "run_1", lastFailure: '{"provenance":"worker_report","outcome":"failed"}' } },
    );
    expect(orcaWorkerEvent(reported)).toEqual({ kind: "finished", detail: "outcome failed, run run_1" });
  });

  test("reads the concise view too", () => {
    const concise = (r: Record<string, unknown>): string => JSON.stringify({ ok: true, result: { runId: "run_2", ...r } });
    expect(orcaWorkerEvent(concise({ state: "succeeded", stage: "settled", liveness: "exited" })).kind).toBe("finished");
    expect(orcaWorkerEvent(concise({ state: "stopped", liveness: "exited", attention: ["failure"] })).kind).toBe("died");
    expect(orcaWorkerEvent(concise({ state: "ready", liveness: "live", attention: ["input"] })).kind).toBe("waiting");
    expect(orcaWorkerEvent(concise({ state: "ready", liveness: "live" })).kind).toBe("running");
  });

  test("an answer that is not a worker record is unknown, never a death", () => {
    expect(orcaWorkerEvent("error: runtime unreachable").kind).toBe("unknown");
    expect(orcaWorkerEvent(JSON.stringify({ ok: false, error: { code: "runtime_unavailable", message: "down" } }))).toEqual({
      kind: "unknown",
      detail: "down",
    });
  });
});

describe("the worker hand-back says which of the three happened", () => {
  const line = (kind: "finished" | "died" | "waiting", detail: string): string =>
    workerEventLine("ctx_abc", { kind, detail });

  test("finished", () => {
    const m = readyMessage("merge its PR", 600_000, line("finished", "outcome succeeded"));
    expect(m).toStartWith("Orca worker ctx_abc FINISHED after 10m (outcome succeeded)");
    expect(m).toContain("merge its PR");
    expect(m).toContain("Do it yourself, now");
  });

  test("a usage line becomes a sentence the turn repeats, never raw JSON", () => {
    const usage = workerUsageLine(
      workerUsage("ctx_abc", "sess-1", [
        { model: "claude-opus-5-5", messages: 3, input: 1000, output: 2000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
      ]),
    );
    const m = readyMessage("merge its PR", 600_000, `${line("finished", "outcome succeeded")}\n${usage}`);
    expect(m).toContain("The worker used 3.0k tokens");
    expect(m).toContain("at list price, claude-opus-5-5 (Claude session sess-1)");
    expect(m).toContain("Say that in one line in your reply");
    expect(m).not.toContain('"models"');
    // no usage line, no sentence
    expect(readyMessage("merge its PR", 600_000, line("finished", "outcome succeeded"))).not.toContain("The worker used");
  });

  test("died", () => {
    const m = readyMessage("merge its PR", 600_000, line("died", "stopped without reporting, task left blocked"));
    expect(m).toStartWith("Orca worker ctx_abc DIED after 10m without reporting (stopped without reporting, task left blocked)");
    expect(m).toContain("Never assume its job is done");
    expect(m).toContain("orca orchestration worker-show --dispatch ctx_abc --json --full");
    expect(m).toContain("`orca orchestration inbox`");
    expect(m).toContain("check the work itself");
  });

  test("waiting for input does not tell it to do the planned part yet", () => {
    const m = readyMessage("merge its PR", 600_000, line("waiting", "Allow edit?"));
    expect(m).toStartWith("Orca worker ctx_abc is WAITING FOR INPUT after 10m (Allow edit?)");
    expect(m).toContain("set a new `watch worker ctx_abc`");
    // a person's answer: ask once, wait for the reply, and stop re-firing on the same question
    expect(m).toContain("ask them here once, set `watch reply`");
    expect(m).toContain("`watch worker ctx_abc --past-wait`");
    expect(m).toContain("Do not do the planned part above until the worker has finished");
    expect(m).not.toContain("Do it yourself, now");
  });

  test("a blocked task in the batch check is flagged as not done", () => {
    const m = readyMessage("merge both PRs", 600_000, "task_aa1 blocked\ntask_bb2 failed\ntrue");
    expect(m).toStartWith("Orca shows task_aa1 as BLOCKED: that worker either stopped without reporting or is parked on an `ask`");
    expect(m).toContain("never count it as a success");
    expect(m).toContain("orca orchestration worker-show --dispatch <its dispatchId> --json --full");
    expect(m).toContain("`orca orchestration worker-list --run <runId> --json` maps a task to its dispatch");
    // parked on an ask: answer and wait again, never redo it
    expect(m).toContain("If it is WAITING on an answer");
    expect(m).toContain("then wait again - re-run the batch check, or set `watch worker <its dispatchId>`");
    expect(m).toContain("do NOT redo its work or carry on with the rest of this until it has finished");
    // only a stopped one is checked and redone
    expect(m).toContain("Only if it STOPPED (stopped, abandoned or ended with nothing pending): check the work itself");
    expect(m).toContain("merge both PRs");
    // every blocked task is named, even past the three lines the tail shows
    const many = readyMessage("go", 60_000, "task_a blocked\ntask_b blocked\ntask_c failed\ntask_d failed\ntrue");
    expect(many).toStartWith("Orca shows task_a, task_b as BLOCKED");
  });

  test("a batch with nothing blocked keeps the plain hand-back", () => {
    expect(readyMessage("go", 60_000, "task_bb2 failed\ntrue")).toStartWith("The thing you were waiting for is ready");
    expect(readyMessage("go", 60_000, "true")).not.toContain("BLOCKED");
  });

  test("any other check keeps the plain hand-back", () => {
    expect(readyMessage("go", 60_000, "orca worker ctx_abc still running")).toStartWith("The thing you were waiting for is ready");
  });
});
