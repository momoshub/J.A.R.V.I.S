import { describe, expect, test } from "bun:test";
import { RESTART_DELAY_MS, RESTART_MAX_WAIT_MS, STANDALONE_REVIEW_RULE, restartWhenIdle, selfUpdateRules } from "../../src/domain/selfUpdate.ts";

const rules = selfUpdateRules("/repo", "/bin/jarvis-restart.sh");

describe("selfUpdateRules", () => {
  test("points at the memory skill for the full procedure", () => {
    expect(rules).toContain("read the skill in your memory about changing your own source");
    // the procedure itself lives in the skill, not in every turn
    expect(rules.length).toBeLessThan(1200);
  });

  test("the restart helper is the gate, and testing a guess by restarting is out", () => {
    expect(rules).toContain("/bin/jarvis-restart.sh");
    expect(rules).toContain("only restarts you if typecheck and tests pass");
    expect(rules).toContain('never restart to "see if that fixed it"');
  });

  test("lands every change through a worktree, a reviewed PR and a pull", () => {
    expect(rules).toContain("never edit /repo in place");
    expect(rules).toContain("git worktree add");
    expect(rules).toContain("merge it yourself");
    expect(rules).toContain("pull --no-rebase");
    expect(rules).toContain("no attribution");
    expect(rules).not.toContain("Generated with Jarvis");
  });

  test("a standalone reviewer comes before the merge", () => {
    expect(rules).toContain("standalone reviewer agent (foreground, fresh context, never you)");
    expect(rules.indexOf("standalone reviewer agent")).toBeLessThan(rules.indexOf("merge it yourself"));
    // the full rule still exists for the prompts that carry it whole
    expect(STANDALONE_REVIEW_RULE).toContain("run_in_background: false");
    expect(STANDALONE_REVIEW_RULE).toContain("At most 3 review rounds");
  });

  test("never rewrites the live database", () => {
    expect(rules).toContain("data/*.db");
    expect(rules).toContain("I crash mid-turn");
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
