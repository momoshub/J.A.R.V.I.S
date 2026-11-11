import { describe, expect, test } from "bun:test";
import {
  asPrState,
  ciStatusOf,
  decodeGate,
  encodeGate,
  failedList,
  gateAction,
  redChangesBody,
  type CiStatus,
  type GateSpec,
} from "../../src/domain/ciGate.ts";

const run = (name: string, status: string, conclusion = "") => ({ name, status, conclusion });

describe("ciStatusOf", () => {
  test("no checks at all is green: there is nothing to wait for", () => {
    expect(ciStatusOf([])).toEqual({ verdict: "green", failed: [] });
  });

  test("everything finished well, skipped and neutral included, is green", () => {
    const s = ciStatusOf([run("a", "COMPLETED", "SUCCESS"), run("b", "COMPLETED", "SKIPPED"), run("c", "COMPLETED", "NEUTRAL")]);
    expect(s.verdict).toBe("green");
  });

  test("a failed check is red and named, in order", () => {
    const s = ciStatusOf([run("typecheck", "COMPLETED", "SUCCESS"), run("tests", "COMPLETED", "FAILURE"), run("lint", "COMPLETED", "TIMED_OUT")]);
    expect(s).toEqual({ verdict: "red", failed: ["tests", "lint"] });
  });

  test("cancelled and action-required count as failed, like `gh pr checks`", () => {
    expect(ciStatusOf([run("a", "COMPLETED", "CANCELLED")]).verdict).toBe("red");
    expect(ciStatusOf([run("a", "COMPLETED", "ACTION_REQUIRED")]).verdict).toBe("red");
  });

  test("queued or in-progress with nothing failed is running", () => {
    expect(ciStatusOf([run("a", "COMPLETED", "SUCCESS"), run("b", "IN_PROGRESS")]).verdict).toBe("running");
    expect(ciStatusOf([run("a", "QUEUED")]).verdict).toBe("running");
    expect(ciStatusOf([run("a", "WAITING")]).verdict).toBe("running");
  });

  test("red beats running: one failure with ten still going is red already", () => {
    const s = ciStatusOf([run("a", "IN_PROGRESS"), run("b", "COMPLETED", "FAILURE")]);
    expect(s).toEqual({ verdict: "red", failed: ["b"] });
  });

  test("a commit status reads by `state`, named by `context`", () => {
    expect(ciStatusOf([{ context: "ci/x", state: "FAILURE" }])).toEqual({ verdict: "red", failed: ["ci/x"] });
    expect(ciStatusOf([{ context: "ci/x", state: "ERROR" }]).verdict).toBe("red");
    expect(ciStatusOf([{ context: "ci/x", state: "PENDING" }]).verdict).toBe("running");
    expect(ciStatusOf([{ context: "ci/x", state: "SUCCESS" }]).verdict).toBe("green");
  });

  test("a superseded run does not count: the newest run of each check wins", () => {
    const old = { name: "checks", workflowName: "CI", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-11-11T10:00:00Z" };
    const skipped = { name: "checks", workflowName: "CI", status: "COMPLETED", conclusion: "SKIPPED", startedAt: "2026-11-11T10:05:00Z" };
    const fresh = { name: "checks", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-11T10:10:00Z" };
    expect(ciStatusOf([old, skipped, fresh]).verdict).toBe("green");
    expect(ciStatusOf([fresh, old]).verdict).toBe("green"); // order of listing does not matter
    // and the other way round: the newest run failing is red even with an older pass
    expect(ciStatusOf([{ ...old, conclusion: "SUCCESS" }, { ...fresh, conclusion: "FAILURE" }])).toEqual({ verdict: "red", failed: ["checks"] });
    // the same name in another workflow is another check
    expect(ciStatusOf([fresh, { ...old, workflowName: "Other" }]).verdict).toBe("red");
  });

  test("garbage entries never throw and never read as a failure", () => {
    expect(ciStatusOf([{ name: 5, status: null, conclusion: {} }]).verdict).toBe("green");
  });
});

describe("gateAction", () => {
  const first: GateSpec = { url: "u", policy: "approve-first" };
  const after: GateSpec = { url: "u", policy: "approve-after" };
  const ci = (verdict: CiStatus["verdict"]): CiStatus => ({ verdict, failed: verdict === "red" ? ["x"] : [] });

  test("merged or closed stops the watcher whatever CI says", () => {
    expect(gateAction(first, { state: "MERGED", ci: ci("red") }, undefined)).toEqual({ do: "stop", why: "merged" });
    expect(gateAction(after, { state: "CLOSED", ci: ci("green") }, "released")).toEqual({ do: "stop", why: "closed" });
  });

  test("red requests changes under either policy and in any phase", () => {
    for (const spec of [first, after]) {
      for (const phase of [undefined, "reviewing", "released", "settled"] as const) {
        expect(gateAction(spec, { state: "OPEN", ci: ci("red") }, phase)).toEqual({ do: "request-changes" });
      }
    }
  });

  test("running waits", () => {
    expect(gateAction(first, { state: "OPEN", ci: ci("running") }, undefined)).toEqual({ do: "wait" });
    expect(gateAction(after, { state: "OPEN", ci: ci("running") }, "released")).toEqual({ do: "wait" });
  });

  test("green: approve-first is done, approve-after approves only once the review released it", () => {
    expect(gateAction(first, { state: "OPEN", ci: ci("green") }, "reviewing")).toEqual({ do: "done" });
    expect(gateAction(after, { state: "OPEN", ci: ci("green") }, "released")).toEqual({ do: "approve" });
    expect(gateAction(after, { state: "OPEN", ci: ci("green") }, "reviewing")).toEqual({ do: "wait" });
    expect(gateAction(after, { state: "OPEN", ci: ci("green") }, undefined)).toEqual({ do: "wait" }); // unknown: never approve
    expect(gateAction(after, { state: "OPEN", ci: ci("green") }, "settled")).toEqual({ do: "done" });
  });
});

describe("the watch row", () => {
  test("a spec survives the round trip through a row's check", () => {
    const spec: GateSpec = { url: "https://github.com/o/r/pull/1", policy: "approve-after" };
    expect(decodeGate(encodeGate(spec))).toEqual(spec);
  });

  test("shell, junk and a spec with a bad policy are not gates", () => {
    expect(decodeGate("gh pr checks x")).toBeUndefined();
    expect(decodeGate("ci-gate:{nope")).toBeUndefined();
    expect(decodeGate('ci-gate:{"url":"u","policy":"never"}')).toBeUndefined();
    expect(decodeGate('ci-gate:{"policy":"approve-first"}')).toBeUndefined();
    expect(decodeGate("ci-gate:null")).toBeUndefined();
  });
});

describe("wording", () => {
  test("failed checks are listed, capped, and the cap says how many are left", () => {
    expect(failedList(["a", "b"])).toBe("`a`, `b`");
    expect(failedList(["a", "b", "c", "d", "e", "f", "g"])).toBe("`a`, `b`, `c`, `d`, `e` and 2 more");
    expect(failedList([])).toBe("a check failed");
  });

  test("the change request says CI is red and which checks", () => {
    expect(redChangesBody(["tests", "lint"], "before")).toBe("requested changes: CI is red (failing: tests, lint)");
    expect(redChangesBody(["tests"], "after")).toContain("red now");
  });

  test("a PR state is read leniently", () => {
    expect(asPrState("open")).toBe("OPEN");
    expect(asPrState("Merged")).toBe("MERGED");
    expect(asPrState("draft")).toBeUndefined();
  });
});
