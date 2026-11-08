import { describe, expect, test } from "bun:test";
import {
  RESTART_DELAY_MS,
  RESTART_MAX_WAIT_MS,
  RESTART_HOLD_NOTICE,
  RESTART_TURN_BUDGET_MS,
  STANDALONE_REVIEW_RULE,
  restartWhenIdle,
  selfPrAccountsRule,
  selfUpdateRules,
} from "../../src/domain/selfUpdate.ts";

const rules = selfUpdateRules("/repo", "/bin/jarvis-restart.sh");

const short = selfUpdateRules("/repo", "/bin/jarvis-restart.sh", true);

describe("selfUpdateRules with a memory skill", () => {
  test("points at the memory skill for the full procedure", () => {
    expect(short).toContain("read the skill in your memory about changing your own source");
    // the procedure itself lives in the skill, not in every turn
    expect(short.length).toBeLessThan(1200);
  });

  test("the restart helper is the gate, and testing a guess by restarting is out", () => {
    expect(short).toContain("/bin/jarvis-restart.sh");
    expect(short).toContain("only restarts you if typecheck and tests pass");
    expect(short).toContain('never restart to "see if that fixed it"');
  });

  test("lands every change through a worktree, a reviewed PR and a pull", () => {
    expect(short).toContain("never edit /repo in place");
    expect(short).toContain("git worktree add");
    expect(short).toContain("merge it yourself");
    expect(short).toContain("pull --no-rebase");
    expect(short).toContain("no attribution");
    expect(short).not.toContain("Generated with Jarvis");
  });

  test("tells the turn what the restart does, and only for a code change", () => {
    expect(short).toContain(`up to ${RESTART_MAX_WAIT_MS / 60_000} minutes`);
    expect(short).toContain("anything you were part-way through is gone");
    expect(short).toContain("for a code change, `/bin/jarvis-restart.sh`");
    expect(short.indexOf("pull --no-rebase")).toBeLessThan(short.indexOf("/bin/jarvis-restart.sh"));
    expect(short).not.toContain("Co-Authored");
  });

  test("a standalone reviewer comes before the merge", () => {
    expect(short).toContain("standalone reviewer agent (an Orca worker, fresh context, never you, talking only through PR comments)");
    expect(short).toContain("green CI before you merge it yourself with `bin/merge-when-green.sh`");
    expect(short.indexOf("standalone reviewer agent")).toBeLessThan(short.indexOf("merge it yourself"));
    // the full rule still exists for the prompts that carry it whole
    expect(STANDALONE_REVIEW_RULE).toContain("orca orchestration worker-start");
    expect(STANDALONE_REVIEW_RULE).toContain("At most 3 review rounds");
  });

  test("never rewrites the live database", () => {
    expect(short).toContain("data/*.db");
    expect(short).toContain("I crash mid-turn");
  });
});

describe("selfUpdateRules with no skill to read (the full block)", () => {
  test("the checks are stated as a gate, with the reason they are not optional", () => {
    // restarting into code that does not compile is a crash-loop KeepAlive
    // cannot break out of, and Slack is no use for fixing it
    expect(rules).toContain("bun run typecheck");
    expect(rules).toContain("bun test");
    expect(rules).toContain("only restarts you if BOTH pass");
    expect(rules).toContain("every fifteen seconds until a human walked to the machine");
  });

  test("the restart is deferred, and it is told why that matters", () => {
    expect(rules).toContain("waits a few seconds so your reply lands first");
    expect(rules).toContain("holds until no turn is running in any thread");
    expect(rules).toContain("New messages are still answered meanwhile, each on a short budget (`RESTART_TURN_BUDGET_MS`, 2 minutes unless set otherwise)");
    expect(rules).toContain("Once the turns from before the restart finish it takes no new message");
    expect(rules).toContain(`after ${RESTART_MAX_WAIT_MS / 60_000} minutes it restarts anyway`);
    expect(rules).toContain("picked up again by the new process on the same session");
    expect(rules).toContain("expect to be a new process");
  });

  test("it must not restart as a way of testing a guess", () => {
    expect(rules).toContain('never restart to "see if that fixed it"');
  });

  test("and lands every change through a worktree and a merged PR", () => {
    expect(rules).toContain("git worktree add");
    expect(rules).toContain("merge it yourself");
    expect(rules).toContain("pull --no-rebase");
    expect(rules).toContain("no attribution");
    expect(rules).not.toContain("Generated with Jarvis");
    expect(rules).not.toContain("do not commit or push");
  });

  test("every fix is reviewed by a standalone agent before it is merged", () => {
    expect(rules).toContain(STANDALONE_REVIEW_RULE);
    expect(rules).toContain("never the session that wrote the code");
    // an Orca worker that talks only on the PR, and the turn still waits for it
    expect(rules).toContain("The reviewer is an Orca worker, never the Agent tool");
    expect(STANDALONE_REVIEW_RULE).toContain("orca orchestration run-create");
    expect(STANDALONE_REVIEW_RULE).toContain("Never end your turn while it is open");
    expect(STANDALONE_REVIEW_RULE).toContain("You never use SendMessage or TaskStop for it");
    expect(STANDALONE_REVIEW_RULE).not.toContain("run_in_background");
    // review and fix rounds are PR comments, marked since both share one account
    expect(STANDALONE_REVIEW_RULE).toContain("`[review round N]`");
    expect(STANDALONE_REVIEW_RULE).toContain("`[fix round N]`");
    expect(STANDALONE_REVIEW_RULE).toContain("`VERDICT: clean`");
    expect(STANDALONE_REVIEW_RULE.indexOf("post a PR comment that starts with `[fix round N]`")).toBeGreaterThan(
      STANDALONE_REVIEW_RULE.indexOf("push, then"),
    );
    // the worker ends itself, so nothing is left running after the merge or
    // when the writer stops without another fix round
    expect(STANDALONE_REVIEW_RULE).toContain("when the PR is merged or closed");
    expect(STANDALONE_REVIEW_RULE).toContain("after 40 minutes with no new `[fix round N]` comment");
    // and the writer never waits forever on a reviewer that died
    expect(STANDALONE_REVIEW_RULE).toContain("shows the reviewer task completed or failed with no new review comment");
    expect(STANDALONE_REVIEW_RULE).toContain("gives up after 30 minutes");
    expect(STANDALONE_REVIEW_RULE).toContain("or the reviewer died or went silent, do not merge");
    // the reviewer never touches the shared checkout it is started in
    expect(STANDALONE_REVIEW_RULE).toContain("never checks out, edits or runs anything in the folder it starts in");
    // the same fallback as every other Orca worker
    expect(STANDALONE_REVIEW_RULE).toContain("or your tools refuse `orca`");
    // with no handle of its own Orca refuses run-create, so that falls back too
    expect(STANDALONE_REVIEW_RULE).toContain("`ORCA_TERMINAL_HANDLE` is unset, `run-create` refuses it as `terminal_handle_stale`");
    // CI is part of the gate, through the helper that refuses on red
    expect(STANDALONE_REVIEW_RULE).toContain("Merge only with `bin/merge-when-green.sh <pr>`");
    expect(STANDALONE_REVIEW_RULE).toContain("Never merge before a clean review and green CI");
    // the helper outlives the default tool timeout, and a slow CI is a retry, not a bypass
    expect(STANDALONE_REVIEW_RULE).toContain("Bash timeout of 600000");
    expect(STANDALONE_REVIEW_RULE).toContain("exit 3 means CI has not finished so run it again");
    expect(STANDALONE_REVIEW_RULE).toContain("approves the PR as the merging account when that account did not open it (a failed approval is no merge)");
    expect(STANDALONE_REVIEW_RULE).toContain("Never fall back to a bare `gh pr merge`");
    // a fix made after review is checked again before it can merge
    expect(STANDALONE_REVIEW_RULE.indexOf("re-run `bun run typecheck` and `bun test`")).toBeGreaterThan(
      STANDALONE_REVIEW_RULE.indexOf("Fix every real finding"),
    );
    // and the loop is bounded, with a way out that is not a merge
    expect(STANDALONE_REVIEW_RULE).toContain("At most 3 review rounds");
    expect(STANDALONE_REVIEW_RULE).toContain("do not merge - leave the PR open");
    // the step sits in the flow before the merge, and the rule before the restart
    const flow = rules.split("\n").find((l) => l.includes("every change goes this way")) ?? "";
    expect(flow.indexOf("standalone reviewer agent")).toBeLessThan(flow.indexOf("merge it yourself"));
    expect(rules.indexOf(STANDALONE_REVIEW_RULE)).toBeLessThan(rules.indexOf("once it is pulled into the main folder"));
  });

  test("is the full block whenever no skill is visible", () => {
    expect(selfUpdateRules("/repo", "/bin/jarvis-restart.sh", false)).toBe(rules);
    expect(rules).not.toContain("read the skill in your memory");
  });

  test("with no repo or no helper, there is no block at all", () => {
    // a role that may not do this must not be told how
    expect(selfUpdateRules(undefined, "/bin/r.sh")).toBe("");
    expect(selfUpdateRules("/repo", undefined)).toBe("");
    expect(selfUpdateRules(undefined, undefined)).toBe("");
  });

  test("the delay leaves room for a reply to land", () => {
    expect(RESTART_DELAY_MS).toBeGreaterThanOrEqual(3_000);
  });
});

describe("restartWhenIdle", () => {
  const harness = (busy: boolean[], maxWaitMs = 1_000) => {
    const pending: { fn: () => void; ms: number }[] = [];
    const logs: string[] = [];
    const events: string[] = [];
    let exits = 0;
    restartWhenIdle({
      onDrain: () => events.push("drain"),
      onForce: () => events.push("force"),
      maxWaitMs,
      isIdle: () => !(busy.shift() ?? false),
      exit: () => {
        exits += 1;
        events.push("exit");
      },
      schedule: (fn, ms) => {
        pending.push({ fn, ms });
      },
      log: (l) => logs.push(l),
      delayMs: 100,
      pollMs: 10,
    });
    const tick = (): number | undefined => {
      const next = pending.shift();
      next?.fn();
      return next?.ms;
    };
    return { pending, logs, events, tick, exits: () => exits };
  };

  test("nothing happens before the delay, so the reply lands first", () => {
    const h = harness([]);
    expect(h.exits()).toBe(0);
    expect(h.pending[0]?.ms).toBe(100);
  });

  test("idle at the delay -> exits straight away", () => {
    const h = harness([false]);
    h.tick();
    expect(h.exits()).toBe(1);
    expect(h.pending).toHaveLength(0);
    expect(h.logs).toHaveLength(0);
  });

  test("busy -> keeps polling and only exits once idle, logging the wait once", () => {
    const h = harness([true, true, true, false]);
    h.tick();
    expect(h.exits()).toBe(0);
    expect(h.pending[0]?.ms).toBe(10);
    h.tick();
    h.tick();
    expect(h.exits()).toBe(0);
    h.tick();
    expect(h.exits()).toBe(1);
    expect(h.pending).toHaveLength(0);
    expect(h.logs).toEqual(["restart deferred: turns still running; new messages still run, each on a short budget"]);
    expect(h.events).toEqual(["drain", "exit"]);
  });

  test("new turns go on a budget the moment it is asked, before the delay even runs", () => {
    const h = harness([]);
    expect(h.events).toEqual(["drain"]);
    expect(h.exits()).toBe(0);
  });

  test("past the longest wait it marks what it cuts, then exits anyway", () => {
    const h = harness(Array(1_000).fill(true), 30);
    h.tick(); // the delay
    h.tick(); // waited 10
    h.tick(); // waited 20
    expect(h.exits()).toBe(0);
    h.tick(); // waited 30 -> forced
    expect(h.events).toEqual(["drain", "force", "exit"]);
    expect(h.pending).toHaveLength(0);
    expect(h.logs.at(-1)).toContain("restart forced");
  });

  test("going idle inside the wait never forces anything", () => {
    const h = harness([true, true, false], 1_000);
    h.tick();
    h.tick();
    h.tick();
    expect(h.events).toEqual(["drain", "exit"]);
  });

  test("once the turns from before it finish, new work stops - once - so the wait converges", () => {
    // A steady trickle of new messages must not keep it from ever being idle:
    // after `settled` it stops taking work and only the budgeted turns remain.
    const pending: { fn: () => void; ms: number }[] = [];
    const events: string[] = [];
    const busy = [true, true, true, true, false];
    const settled = [false, true, true, true];
    restartWhenIdle({
      onDrain: () => events.push("drain"),
      onSettled: () => events.push("settled"),
      settled: () => settled.shift() ?? true,
      onForce: () => events.push("force"),
      isIdle: () => !(busy.shift() ?? false),
      exit: () => events.push("exit"),
      schedule: (fn, ms) => void pending.push({ fn, ms }),
      delayMs: 100,
      pollMs: 10,
      maxWaitMs: 1_000,
    });
    while (pending.length > 0) pending.shift()?.fn();
    expect(events).toEqual(["drain", "settled", "exit"]);
  });

  test("idle before anything settles exits without closing the intake", () => {
    const events: string[] = [];
    const pending: (() => void)[] = [];
    restartWhenIdle({
      onSettled: () => events.push("settled"),
      settled: () => true,
      isIdle: () => true,
      exit: () => events.push("exit"),
      schedule: (fn) => void pending.push(fn),
    });
    pending.shift()?.();
    expect(events).toEqual(["exit"]);
  });

  test("the turn budget is short next to the longest wait", () => {
    expect(RESTART_TURN_BUDGET_MS).toBeGreaterThanOrEqual(30_000);
    expect(RESTART_TURN_BUDGET_MS).toBeLessThan(RESTART_MAX_WAIT_MS);
    expect(RESTART_HOLD_NOTICE).toContain("đợi em xíu");
  });

  test("the default wait is bounded, and long enough for an ordinary turn", () => {
    expect(RESTART_MAX_WAIT_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(RESTART_MAX_WAIT_MS).toBeLessThanOrEqual(60 * 60_000);
  });
});

describe("self PR accounts", () => {
  const accounts = { author: "writer", reviewer: "checker" };

  test("no split, no line: one account does it all", () => {
    expect(selfPrAccountsRule()).toBe("");
    expect(short).not.toContain("GitHub accounts:");
    expect(rules).not.toContain("GitHub accounts:");
  });

  test("the author opens the PR, the reviewer comments and merges", () => {
    const line = selfPrAccountsRule(accounts);
    expect(line).toContain("open the PR and post every `[fix round N]` comment as `writer`");
    expect(line).toContain("`GH_TOKEN=$(gh auth token -u writer)` in front of `gh pr create`");
    expect(line).toContain("posts every `[review round N]` comment as `checker`");
    expect(line).toContain("merge as `checker`: `GH_TOKEN=$(gh auth token -u checker)` in front of `bin/merge-when-green.sh <pr>`");
    expect(line).toContain("which approves the PR as `checker` right before it merges");
    // switching the active account would move it under every other session
    expect(line).toContain("Never `gh auth switch`");
    // a login gh does not hold must stop the step, not fall back to the active account
    expect(line).toContain("if `gh auth token -u <login>` fails or prints nothing, stop and say so");
    expect(line).toContain("say the same in the reviewer's brief");
  });

  test("both the short and the full block carry it", () => {
    expect(selfUpdateRules("/repo", "/bin/r.sh", true, accounts)).toContain(selfPrAccountsRule(accounts));
    expect(selfUpdateRules("/repo", "/bin/r.sh", false, accounts)).toContain(selfPrAccountsRule(accounts));
  });

  test("the review rule no longer assumes one shared account", () => {
    expect(STANDALONE_REVIEW_RULE).not.toContain("Both sides post from the same GitHub account");
    expect(STANDALONE_REVIEW_RULE).toContain("even when both post from the same GitHub account");
  });
});
