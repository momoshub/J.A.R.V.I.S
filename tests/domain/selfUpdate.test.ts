import { describe, expect, test } from "bun:test";
import { RESTART_DELAY_MS, restartWhenIdle, selfUpdateRules } from "../../src/domain/selfUpdate.ts";

const rules = selfUpdateRules("/repo", "/bin/jarvis-restart.sh");

describe("selfUpdateRules", () => {
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
    expect(rules).toContain("expect to be a new process");
  });

  test("it must not restart as a way of testing a guess", () => {
    expect(rules).toContain('never restart to "see if that fixed it"');
  });

  test("and lands every change through a worktree and a merged PR", () => {
    expect(rules).toContain("git worktree add");
    expect(rules).toContain("merge it yourself");
    expect(rules).toContain("pull --no-rebase");
    expect(rules).toContain("Generated with Jarvis");
    expect(rules).not.toContain("do not commit or push");
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
  const harness = (busy: boolean[]) => {
    const pending: { fn: () => void; ms: number }[] = [];
    const logs: string[] = [];
    let exits = 0;
    restartWhenIdle({
      isIdle: () => !(busy.shift() ?? false),
      exit: () => {
        exits += 1;
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
    return { pending, logs, tick, exits: () => exits };
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
    expect(h.logs).toEqual(["restart deferred: turns still running, waiting for idle"]);
  });
});
