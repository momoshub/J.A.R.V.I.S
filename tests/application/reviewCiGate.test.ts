import { beforeEach, describe, expect, test } from "bun:test";
import { createSettingsRepo } from "../../src/infrastructure/db/settingsRepo.ts";
import { createWatchRepo, type WatchRepo } from "../../src/infrastructure/db/watchRepo.ts";
import { dispatchCommand, type CommandDeps } from "../../src/application/commands.ts";
import { createCiGate, type CiGate } from "../../src/application/ciGate.ts";
import { createWatcher, type Watcher } from "../../src/application/watcher.ts";
import type { GitHubPort, PrSnapshot } from "../../src/application/github.ts";
import type { LlmPort } from "../../src/application/ports.ts";
import { GATE_DEADLINE_MS, GATE_EVERY_MS, type CiStatus, type PrState } from "../../src/domain/ciGate.ts";
import { actor, build, db } from "./commandsFixture.ts";

const PR = "https://github.com/o/r/pull/1";

const RED: CiStatus = { verdict: "red", failed: ["checks", "lint"] };
const RUNNING: CiStatus = { verdict: "running", failed: [] };
const GREEN: CiStatus = { verdict: "green", failed: [] };

/** One PR on a fake GitHub that remembers what was done to it, in order. */
type World = {
  state: PrState;
  ci: CiStatus;
  decision?: string;
  mine?: string;
  /** `approve`, `request-changes:<body>` - everything the bot submitted. */
  log: string[];
  unreadable: boolean;
};

let world: World;
let now: number;
let watches: WatchRepo;
let gate: CiGate;
let watcher: Watcher;
let said: string[];
let turns: string[];

const fakeGithub = (): GitHubPort => ({
  whoami: async () => ({ login: "kai-at-acme", name: "Kai" }),
  reviewDecision: async () => world.decision,
  approve: async () => {
    world.log.push("approve");
    world.mine = "APPROVED";
    world.decision = "APPROVED";
    return { ok: true };
  },
  requestChanges: async (_url, body) => {
    world.log.push(`request-changes:${body}`);
    world.mine = "CHANGES_REQUESTED";
    world.decision = "CHANGES_REQUESTED";
    return { ok: true };
  },
  snapshot: async (): Promise<PrSnapshot | undefined> =>
    world.unreadable ? undefined : { state: world.state, ci: world.ci, decision: world.decision, mine: world.mine },
});

beforeEach(() => {
  world = { state: "OPEN", ci: GREEN, log: [], unreadable: false };
  now = 1_000_000;
  said = [];
  turns = [];
});

/** deps with the gate wired the way index.ts wires it, and a brain that records its prompt. */
const setup = (brain: (system: string) => string | void = () => {}, over: Partial<GitHubPort> = {}) => {
  const base = build();
  watches = createWatchRepo(db);
  const github: GitHubPort = { ...fakeGithub(), ...over };
  gate = createCiGate({ github, watches, clock: () => now, say: async (_c, text) => void said.push(text) });
  watcher = createWatcher({
    watches,
    clock: () => now,
    check: async () => ({ code: 1, output: "" }),
    runTurn: async (r) => void turns.push(r.text),
    gate: { step: gate.step, stop: gate.stop },
    say: async (_c, text) => void said.push(text),
  });
  const prompts: string[] = [];
  const llm: LlmPort = {
    complete: async (p) => {
      world.log.push("brain");
      prompts.push(p.system);
      return brain(p.system) ?? "the review";
    },
  };
  const deps: CommandDeps = { ...base, github, ciGate: gate, llm };
  deps.settings = createSettingsRepo(db);
  const lines: string[] = [];
  const run = (flag: "first" | "after", line = `rv ${PR} --policy ${flag}`) =>
    dispatchCommand(deps, actor(), "C1", line, {
      threadTs: "1.1",
      reply: async (t: string) => {
        lines.push(t);
      },
    });
  return { deps, run, lines, prompts };
};

/** Move the clock one poll on and let the watcher look. */
const poll = async () => {
  now += GATE_EVERY_MS;
  await watcher.tick();
};

const gateRows = () => watches.waiting(50).filter((w) => w.check.startsWith("ci-gate:"));
const rcs = () => world.log.filter((l) => l.startsWith("request-changes"));
const approvals = () => world.log.filter((l) => l === "approve");

describe("review is gated on CI - approve-first", () => {
  test("red: changes are requested first, saying which checks, then the review runs; never approved", async () => {
    world.ci = RED;
    const { run, lines, prompts } = setup();
    await run("first");

    expect(world.log).toEqual(["request-changes:requested changes: CI is red (failing: checks, lint)", "brain"]);
    expect(lines[0]).toContain("🔍 reviewing");
    expect(lines[1]).toBe(`🔴 CI is red on ${PR} (\`checks\`, \`lint\`) - requested changes`);
    expect(lines.some((l) => l.startsWith("✅ approved"))).toBe(false);
    // the brain is told the change request is in, so it does not submit a second one
    expect(prompts[0]).toContain("change request ALREADY submitted");
    expect(prompts[0]).toContain(PR);
    expect(gateRows()).toHaveLength(0); // red has nothing to wait for
  });

  test("green: approved up front, no watcher, nothing else", async () => {
    world.ci = GREEN;
    const { run, lines, prompts } = setup();
    await run("first");

    expect(world.log).toEqual(["approve", "brain"]);
    expect(lines[1]).toBe(`✅ approved ${PR}`);
    expect(gateRows()).toHaveLength(0);
    expect(prompts[0]).not.toContain("change request ALREADY submitted");
  });

  test("running: a watcher is started, then approved up front, then the review", async () => {
    world.ci = RUNNING;
    const { run, lines } = setup();
    await run("first");

    expect(world.log).toEqual(["approve", "brain"]);
    expect(lines[1]).toBe(`🟡 CI is still running on ${PR} - watching it`);
    expect(lines[2]).toBe(`✅ approved ${PR}`);
    const rows = gateRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.note).toContain("approve first");
    expect(rows[0]?.deadlineAt).toBe(now + GATE_DEADLINE_MS);
    expect(turns).toEqual([]); // no model turn: the gate acts in code
  });

  test("running, then the watcher sees red after the approval: changes requested, once", async () => {
    world.ci = RUNNING;
    const { run } = setup();
    await run("first");
    await poll(); // still running
    expect(rcs()).toHaveLength(0);

    world.ci = RED;
    await poll();
    expect(rcs()).toEqual(["request-changes:requested changes: CI is red now (failing: checks, lint)"]);
    expect(said.some((l) => l.includes("CI went red") && l.includes("requested changes"))).toBe(true);

    // settled: more polls, and a second review, add no second change request
    await poll();
    await poll();
    expect(rcs()).toHaveLength(1);
    expect(gateRows()).toHaveLength(0);
  });

  test("running, then green: the watcher ends quietly, the up-front approval stands", async () => {
    world.ci = RUNNING;
    const { run } = setup();
    await run("first");
    world.ci = GREEN;
    await poll();
    expect(world.log).toEqual(["approve", "brain"]);
    expect(gateRows()).toHaveLength(0);
    expect(said).toEqual([]);
  });

  test("a blocker found by the review is the brain's flow B, and CI turning red later does not double it", async () => {
    world.ci = RUNNING;
    // the brain's own `gh pr review --request-changes` (flow B)
    const { run } = setup(() => {
      world.log.push("request-changes:requested changes");
      world.mine = "CHANGES_REQUESTED";
      world.decision = "CHANGES_REQUESTED";
    });
    await run("first");
    world.ci = RED;
    await poll();
    expect(rcs()).toEqual(["request-changes:requested changes"]); // ours is already the latest review
  });
});

describe("review is gated on CI - approve-after", () => {
  test("red: changes are requested first, the review runs, nothing is approved at the end", async () => {
    world.ci = RED;
    const { run, lines } = setup();
    await run("after");

    expect(world.log).toEqual(["request-changes:requested changes: CI is red (failing: checks, lint)", "brain"]);
    expect(approvals()).toHaveLength(0);
    expect(lines.some((l) => l.includes("approved"))).toBe(false);
    expect(gateRows()).toHaveLength(0);
  });

  test("green and clean: the review runs, then it is approved", async () => {
    world.ci = GREEN;
    const { run, lines } = setup();
    await run("after");

    expect(world.log).toEqual(["brain", "approve"]); // never before the review
    expect(lines[lines.length - 1]).toBe(`✅ approved ${PR} - the review came back clean`);
    expect(gateRows()).toHaveLength(0);
  });

  test("green but the review found a blocker: not approved", async () => {
    world.ci = GREEN;
    const { run, lines } = setup(() => {
      world.log.push("request-changes:requested changes"); // flow B
      world.decision = "CHANGES_REQUESTED";
      world.mine = "CHANGES_REQUESTED";
    });
    await run("after");
    expect(approvals()).toHaveLength(0);
    expect(lines[lines.length - 1]).toBe(`🚫 not approving ${PR} - changes are requested`);
  });

  test("running at the start, green by the end of the review: approved by the command, the watcher adds nothing", async () => {
    world.ci = RUNNING;
    const { run } = setup(() => {
      world.ci = GREEN; // CI finished while the review was being written
    });
    await run("after");
    expect(world.log).toEqual(["brain", "approve"]);
    await poll();
    await poll();
    expect(approvals()).toHaveLength(1); // never twice
    expect(gateRows()).toHaveLength(0);
  });

  test("still running at the end: approval waits for the watcher, and green approves once", async () => {
    world.ci = RUNNING;
    const { run, lines } = setup();
    await run("after");

    expect(world.log).toEqual(["brain"]);
    expect(lines[lines.length - 1]).toContain("I approve once it is green");
    expect(gateRows()).toHaveLength(1);

    await poll();
    expect(approvals()).toHaveLength(0);
    world.ci = GREEN;
    await poll();
    expect(approvals()).toHaveLength(1);
    expect(said.some((l) => l.includes("approved") && l.includes("CI is green"))).toBe(true);
    await poll();
    expect(approvals()).toHaveLength(1);
    expect(gateRows()).toHaveLength(0);
  });

  test("still running at the end, then red: changes requested, never approved", async () => {
    world.ci = RUNNING;
    const { run } = setup();
    await run("after");
    world.ci = RED;
    await poll();
    expect(approvals()).toHaveLength(0);
    expect(rcs()).toHaveLength(1);
  });

  test("red during the review: the watcher requests changes at once, and the end does not approve", async () => {
    world.ci = RUNNING;
    const { run, lines } = setup(() => {
      world.ci = RED;
    });
    await run("after");
    // the end of the review looks again and finds red itself
    expect(rcs()).toHaveLength(1);
    expect(approvals()).toHaveLength(0);
    expect(lines[lines.length - 1]).toContain("CI is red");
    await poll();
    expect(rcs()).toHaveLength(1);
  });

  test("a blocker found while CI runs: not approved, and green later does not approve either", async () => {
    world.ci = RUNNING;
    const { run } = setup(() => {
      world.log.push("request-changes:requested changes");
      world.decision = "CHANGES_REQUESTED";
      world.mine = "CHANGES_REQUESTED";
    });
    await run("after");
    world.ci = GREEN;
    await poll();
    expect(approvals()).toHaveLength(0);
    expect(gateRows()).toHaveLength(0);
  });

  test("a review cut off while CI runs is never approved by the watcher", async () => {
    world.ci = RUNNING;
    const { deps } = setup();
    const lines: string[] = [];
    const cut: LlmPort = {
      complete: async () => "unused",
      stream: async (_p, sink) => {
        sink({ type: "aborted", reason: "it ran out of time" });
        return "partial";
      },
    };
    await dispatchCommand({ ...deps, llm: cut }, actor(), "C1", `rv ${PR} --policy after`, {
      threadTs: "1.1",
      reply: async (t: string) => void lines.push(t),
    });
    world.ci = GREEN;
    await poll();
    expect(approvals()).toHaveLength(0);
    expect(gateRows()).toHaveLength(0); // settled quietly, nothing was approved or requested
    expect(rcs()).toHaveLength(0);
  });

  test("CI that never settles: after the deadline it says so and approves nothing", async () => {
    world.ci = RUNNING;
    const { run } = setup();
    await run("after");
    now += GATE_DEADLINE_MS;
    await watcher.tick();
    expect(approvals()).toHaveLength(0);
    expect(rcs()).toHaveLength(0);
    expect(said.some((l) => l.includes("not approving") && l.includes("did not settle"))).toBe(true);
    expect(gateRows()).toHaveLength(0);
  });
});

describe("the CI watcher is idempotent and respects the PR's state", () => {
  test("merged or closed before CI settles: no request-changes, no approval, one line", async () => {
    for (const state of ["MERGED", "CLOSED"] as const) {
      world = { state: "OPEN", ci: RUNNING, log: [], unreadable: false };
      said = [];
      const { run } = setup();
      await run("first");
      world.state = state;
      world.ci = RED;
      await poll();
      expect(rcs()).toHaveLength(0);
      expect(said).toEqual([`🛑 ${PR} is ${state.toLowerCase()} - stopped watching its CI`]);
      expect(gateRows()).toHaveLength(0);
    }
  });

  test("two reviews of one PR keep one watcher", async () => {
    world.ci = RUNNING;
    const { run } = setup();
    await run("first");
    await run("first");
    expect(gateRows()).toHaveLength(1);
  });

  test("a different policy replaces the watcher instead of doubling it", async () => {
    world.ci = RUNNING;
    const { run } = setup();
    await run("first");
    await run("after");
    const rows = gateRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.note).toContain("approve after");
  });

  test("an unreadable PR just polls on: nothing is requested or approved", async () => {
    world.ci = RUNNING;
    const { run } = setup();
    await run("after");
    world.unreadable = true;
    await poll();
    await poll();
    expect(world.log).toEqual(["brain"]);
    expect(gateRows()).toHaveLength(1);
  });

  test("a change request of ours that is already the latest is not submitted again", async () => {
    world.ci = RED;
    world.mine = "CHANGES_REQUESTED";
    const { run, lines } = setup();
    await run("first");
    expect(rcs()).toHaveLength(0);
    expect(lines[1]).toContain("changes already requested");
  });

  test("a failed request-changes is reported, the PR is still not approved, the review still runs", async () => {
    world.ci = RED;
    const { run, lines, prompts } = setup(() => {}, { requestChanges: async () => ({ ok: false, error: "no permission" }) });
    await run("first");
    expect(lines.some((l) => l.includes("could not request changes - no permission"))).toBe(true);
    expect(approvals()).toHaveLength(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("change request ALREADY submitted");
  });

  test("a setter who is no longer allowed ends the watcher without acting", async () => {
    world.ci = RUNNING;
    const { run } = setup();
    await run("after");
    const guarded = createWatcher({
      watches,
      clock: () => now,
      check: async () => ({ code: 1, output: "" }),
      runTurn: async () => {},
      gate: { step: gate.step, stop: gate.stop },
      say: async (_c, text) => void said.push(text),
      mayRun: () => false,
    });
    world.ci = GREEN;
    now += GATE_EVERY_MS;
    await guarded.tick();
    expect(approvals()).toHaveLength(0);
    expect(gateRows()).toHaveLength(0);
  });
});

describe("without a CI gate or a readable PR, review is what it was", () => {
  test("no gate wired: approve-first approves, approve-after approves after the review", async () => {
    const { deps } = setup();
    for (const flag of ["first", "after"] as const) {
      world = { state: "OPEN", ci: RED, log: [], unreadable: false };
      await dispatchCommand({ ...deps, ciGate: undefined }, actor(), "C1", `rv ${PR} --policy ${flag}`, {
        reply: async () => {},
      });
      expect(world.log).toEqual(flag === "first" ? ["approve", "brain"] : ["brain", "approve"]);
    }
  });

  test("a PR GitHub cannot be read for goes the old way", async () => {
    world.unreadable = true;
    const { run } = setup();
    await run("first");
    expect(world.log).toEqual(["approve", "brain"]);
  });

  test("a merged PR goes the old way too: no change request on it", async () => {
    world.state = "MERGED";
    world.ci = RED;
    const { run } = setup();
    await run("after");
    expect(rcs()).toHaveLength(0);
  });
});
