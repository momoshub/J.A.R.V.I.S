import { describe, expect, test } from "bun:test";
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
  const PR = "https://github.com/acme/acme-be/pull/14538";

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
