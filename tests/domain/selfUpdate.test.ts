import { describe, expect, test } from "bun:test";
import { RESTART_DELAY_MS, RESTART_MAX_WAIT_MS, STANDALONE_REVIEW_RULE, restartWhenIdle, selfUpdateRules } from "../../src/domain/selfUpdate.ts";

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
    expect(short).toContain("standalone reviewer agent (background, fresh context, never you, stopped after the merge)");
    expect(short).toContain("green CI before you merge it yourself with `bin/merge-when-green.sh`");
    expect(short.indexOf("standalone reviewer agent")).toBeLessThan(short.indexOf("merge it yourself"));
    // the full rule still exists for the prompts that carry it whole
    expect(STANDALONE_REVIEW_RULE).toContain("run_in_background: true");
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
    expect(rules).toContain("taking no new message meanwhile");
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
    // in the background, talked to over SendMessage, but the turn still waits
    // for it and stops it once the PR is settled
    expect(rules).toContain("run_in_background: true");
    expect(STANDALONE_REVIEW_RULE).toContain("Never end your turn while it is open");
    expect(STANDALONE_REVIEW_RULE).toContain("tell the same reviewer what you changed with SendMessage");
    expect(STANDALONE_REVIEW_RULE.indexOf("stop the reviewer with TaskStop")).toBeGreaterThan(
      STANDALONE_REVIEW_RULE.indexOf("bin/merge-when-green.sh"),
    );
    // CI is part of the gate, through the helper that refuses on red
    expect(STANDALONE_REVIEW_RULE).toContain("Merge only with `bin/merge-when-green.sh <pr>`");
    expect(STANDALONE_REVIEW_RULE).toContain("Never merge before a clean review and green CI");
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
    expect(h.logs).toEqual(["restart deferred: turns still running, taking no new work until they finish"]);
    expect(h.events).toEqual(["drain", "exit"]);
  });

  test("new work stops the moment it is asked, before the delay even runs", () => {
    // a busy thread must not keep the bot from ever being idle
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

  test("the default wait is bounded, and long enough for an ordinary turn", () => {
    expect(RESTART_MAX_WAIT_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(RESTART_MAX_WAIT_MS).toBeLessThanOrEqual(60 * 60_000);
  });
});
