import { describe, expect, test } from "bun:test";
import {
  LOOP_ACTION_PREFIX,
  LOOP_APPROVE_ACTION,
  LOOP_REJECT_ACTION,
  MIN_INTERVAL_MS,
  MIN_SCRIPT_INTERVAL_MS,
  PENDING_TTL_MS,
  approvalText,
  cleanName,
  deriveName,
  loopRef,
  loopTurnText,
  loopThreadTs,
  nextRun,
  parseLoopArgs,
  parseSchedule,
  scheduleText,
  settledLoopText,
} from "../../src/domain/loop.ts";

// Thu 05/11/2026 17:30 at +07:00.
const OFFSET = 7 * 60;
const NOW = Date.UTC(2026, 10, 5, 10, 30);
const at = (y: number, mo: number, d: number, h: number, m = 0) => Date.UTC(y, mo - 1, d, h, m) - OFFSET * 60_000;

const ok = (s: string) => {
  const p = parseLoopArgs(s);
  if (!p.ok) throw new Error(p.error);
  return p;
};

describe("parseLoopArgs: prompt mode", () => {
  test("every monday 9am", () => {
    const p = ok("every monday 9am search the web for new slang");
    expect(p.schedule).toEqual({ kind: "weekly", weekday: 1, minutes: 9 * 60 });
    expect(p.prompt).toBe("search the web for new slang");
    expect(p.command).toBe("");
  });
  test("a weekday with no hour is 09:00, and short names work", () => {
    expect(ok("every fri update it").schedule).toEqual({ kind: "weekly", weekday: 5, minutes: 540 });
    expect(ok("every mondays at 7:30am go").schedule).toEqual({ kind: "weekly", weekday: 1, minutes: 450 });
  });
  test("every day at 18:00", () => {
    const p = ok("every day at 18:00 summarise the day");
    expect(p.schedule).toEqual({ kind: "daily", minutes: 18 * 60 });
    expect(p.prompt).toBe("summarise the day");
  });
  test("every day with no clock is a 24h interval and the prompt keeps its words", () => {
    const p = ok("every day 18 things to check");
    expect(p.schedule).toEqual({ kind: "interval", everyMs: 86_400_000 });
    expect(p.prompt).toBe("18 things to check");
  });
  test("every 6h and every week", () => {
    expect(ok("every 6h check").schedule).toEqual({ kind: "interval", everyMs: 6 * 3_600_000 });
    expect(ok("every week check").schedule).toEqual({ kind: "interval", everyMs: 7 * 86_400_000 });
  });
  test("refuses under an hour, a bare number, no prompt and no schedule", () => {
    expect(parseLoopArgs("every 30m check")).toEqual({ ok: false, error: "the shortest loop is every 1h" });
    expect(parseLoopArgs("every 6 check").ok).toBe(false);
    expect(parseLoopArgs("every monday 9am").ok).toBe(false);
    expect(parseLoopArgs("monday check").ok).toBe(false);
    expect(parseLoopArgs("every blue moon check").ok).toBe(false);
    expect(MIN_INTERVAL_MS).toBe(3_600_000);
  });
});

describe("parseLoopArgs: script mode", () => {
  test("reads `-- <shell>` verbatim", () => {
    const p = ok("every 15m -- curl -s 'https://x.test/a  b' | jq .ok");
    expect(p.schedule).toEqual({ kind: "interval", everyMs: 900_000 });
    expect(p.command).toBe("curl -s 'https://x.test/a  b' | jq .ok");
    expect(p.prompt).toBe("");
  });
  test("decodes Slack escapes and unwraps links", () => {
    const p = ok("every 15m -- test -f x &amp;&amp; curl -s <https://x.test/a?b=1&amp;c=2> &gt; /tmp/y &lt; <https://x.test|x.test>");
    expect(p.command).toBe("test -f x && curl -s https://x.test/a?b=1&c=2 > /tmp/y < https://x.test");
  });
  test("works after a clock schedule", () => {
    const p = ok("every monday 9am -- ./sync.sh --all");
    expect(p.schedule).toEqual({ kind: "weekly", weekday: 1, minutes: 540 });
    expect(p.command).toBe("./sync.sh --all");
  });
  test("minimum is 5m, not 1h", () => {
    expect(ok("every 5m -- true").command).toBe("true");
    expect(parseLoopArgs("every 4m -- true")).toEqual({ ok: false, error: "the shortest script loop is every 5m" });
    expect(MIN_SCRIPT_INTERVAL_MS).toBe(300_000);
  });
  test("needs a command after --", () => {
    expect(parseLoopArgs("every 1h --").ok).toBe(false);
  });
});

describe("script loop approval text", () => {
  test("shows the exact schedule and command, and never lets the command close its own fence", () => {
    const t = approvalText(7, "every 15m", "echo ```; rm -rf x");
    expect(t).toContain("#7");
    expect(t).toContain("every 15m");
    expect(t).toContain(`echo ${"'".repeat(3)}; rm -rf x`);
    expect(t.match(/```/g)).toHaveLength(2);
    expect(t).toContain("24h");
  });
  test("shows <, > and & escaped, so Slack cannot render a link or mention in place of the shell", () => {
    const t = approvalText(8, "every 15m", "curl -s '<https://evil.example|echo backup ok>' && echo <!channel> > /tmp/x &");
    expect(t).toContain("curl -s '&lt;https://evil.example|echo backup ok&gt;' &amp;&amp; echo &lt;!channel&gt; &gt; /tmp/x &amp;");
    expect(t).not.toMatch(/<https:|<!channel>/);
  });
  test("the buttons are jv: ids, and a pending loop lives 24h", () => {
    expect(LOOP_APPROVE_ACTION).toBe("jv:loop:approve");
    expect(LOOP_REJECT_ACTION).toBe("jv:loop:reject");
    expect(LOOP_APPROVE_ACTION.startsWith(LOOP_ACTION_PREFIX)).toBe(true);
    expect(PENDING_TTL_MS).toBe(86_400_000);
  });
  test("settled text says what was decided", () => {
    expect(settledLoopText("approved", 3, "U1")).toContain("approved by <@U1>");
    expect(settledLoopText("rejected", 3)).toContain("deleted");
    expect(settledLoopText("expired", 3)).toContain("expired");
  });
});

describe("nextRun", () => {
  test("interval counts from now", () => {
    expect(nextRun({ kind: "interval", everyMs: 3_600_000 }, NOW, OFFSET)).toBe(NOW + 3_600_000);
  });
  test("daily: later today, else tomorrow", () => {
    expect(nextRun({ kind: "daily", minutes: 18 * 60 }, NOW, OFFSET)).toBe(at(2026, 11, 5, 18));
    expect(nextRun({ kind: "daily", minutes: 9 * 60 }, NOW, OFFSET)).toBe(at(2026, 11, 6, 9));
  });
  test("exactly on the slot moves to the next one", () => {
    expect(nextRun({ kind: "daily", minutes: 17 * 60 + 30 }, NOW, OFFSET)).toBe(at(2026, 11, 6, 17, 30));
  });
  test("weekly: next monday, and a same-day slot already passed waits a week", () => {
    expect(nextRun({ kind: "weekly", weekday: 1, minutes: 540 }, NOW, OFFSET)).toBe(at(2026, 11, 9, 9));
    expect(nextRun({ kind: "weekly", weekday: 4, minutes: 18 * 60 }, NOW, OFFSET)).toBe(at(2026, 11, 5, 18));
    expect(nextRun({ kind: "weekly", weekday: 4, minutes: 9 * 60 }, NOW, OFFSET)).toBe(at(2026, 11, 12, 9));
  });
});

describe("schedule text", () => {
  test("round-trips through parseSchedule", () => {
    for (const line of ["every monday 9am x", "every day at 18:00 x", "every 6h x", "every week x", "every 90m x"]) {
      const s = ok(line).schedule;
      expect(parseSchedule(scheduleText(s))).toEqual(s);
    }
    expect(scheduleText({ kind: "weekly", weekday: 1, minutes: 540 })).toBe("every monday at 09:00");
  });
  test("a stored 5m script schedule is still readable", () => {
    expect(parseSchedule("every 5m")).toEqual({ kind: "interval", everyMs: 300_000 });
  });
});

describe("loopTurnText", () => {
  test("is prefixed so the turn knows it is scheduled", () => {
    const t = loopTurnText(7, "every day at 18:00", "do it");
    expect(t.startsWith("[loop 7] ")).toBe(true);
    expect(t.endsWith("do it")).toBe(true);
  });

  test("tells the turn to stay silent unless the task asks or a person is needed, else NO_REPLY", () => {
    const t = loopTurnText(7, "every 1h", "do it");
    expect(t).toContain("nobody is watching");
    expect(t).toContain("post nothing anywhere in Slack");
    expect(t).toContain("explicitly asks you to send, post or report");
    expect(t).toContain("needs a person");
    expect(t).toContain("end with exactly NO_REPLY");
  });
});

describe("loopThreadTs", () => {
  test("is a Slack-shaped ts, unique per loop within one tick, stable for one loop and moment", () => {
    const now = Date.UTC(2026, 10, 14, 9, 0, 0, 123);
    expect(loopThreadTs(now, 7)).toMatch(/^\d{10}\.\d{6}$/);
    expect(loopThreadTs(now, 7)).not.toBe(loopThreadTs(now, 8));
    expect(loopThreadTs(now, 7)).toBe(loopThreadTs(now, 7));
    expect(Number(loopThreadTs(now, 7))).toBeGreaterThan(Math.floor(now / 1000) - 1);
  });
});

describe("loop names", () => {
  test("cleanName leaves plain words: no mrkdwn, links, mentions or entities, one line, clipped", () => {
    expect(cleanName("  PR   board ")).toBe("PR board");
    expect(cleanName("*bold* _it_ `code` ~x~")).toBe("bold it code x");
    expect(cleanName("<!channel> <@U1|kai> & <https://x.y|link>")).not.toMatch(/[<>&|]/);
    expect(cleanName("a\nb\tc")).toBe("a b c");
    expect(cleanName("x".repeat(100))).toHaveLength(40);
    expect(cleanName("***")).toBe("");
  });

  test("cleanName reads Slack's escapes and markup as the words a person sees", () => {
    expect(cleanName("Q&amp;A board")).toBe("Q A board");
    expect(cleanName("R&lt;D&gt;")).toBe("R D");
    expect(cleanName("see <https://x.y/pulls|open PRs>")).toBe("see open PRs");
    expect(cleanName("ping <@U1|kai> in <#C1|ops> <!here>")).toBe("ping kai in ops here");
  });

  test("deriveName reads a link as its label, not its url", () => {
    expect(deriveName("check <https://github.com/o/r/pulls|open PRs> today")).toBe("check open PRs today");
  });

  test("deriveName takes the first few words of the prompt, else of the command", () => {
    expect(deriveName("check the open pull requests and summarise them for me")).toBe("check the open pull");
    expect(deriveName("  *urgent*   look at <https://x.y|this> ")).not.toMatch(/[*<>|]/);
    expect(deriveName("", "./sync.sh --all")).toBe("./sync.sh --all");
    expect(deriveName("", "***")).toBe("script");
    expect(deriveName("***")).toBe("loop");
  });

  test("loopRef reads `<name> - loop #<id>`, or `loop #<id>` with no name", () => {
    expect(loopRef(3, "PR board")).toBe("PR board - loop #3");
    expect(loopRef(3, "")).toBe("loop #3");
    expect(loopRef(3, "Sync", "script loop")).toBe("Sync - script loop #3");
  });

  test("the approval and settled texts carry the name", () => {
    const named = approvalText(7, "every 15m", "./x", PENDING_TTL_MS, "Sync");
    expect(named).toContain("script loop (#7)");
    expect(named).toContain("name (chosen by the turn, not checked): Sync");
    expect(approvalText(7, "every 15m", "./x")).not.toContain("name (");
    expect(settledLoopText("approved", 3, "U1", "Sync")).toContain("Sync - script loop #3 approved by <@U1>");
    expect(settledLoopText("rejected", 3, undefined, "Sync")).toContain("Sync - script loop #3 rejected");
    expect(settledLoopText("expired", 3, undefined, "Sync")).toContain("Sync - script loop #3 expired");
  });

  test("the turn text names the loop", () => {
    expect(loopTurnText(7, "every 1h", "do it", "PR board")).toContain('Scheduled run of "PR board" (every 1h)');
    expect(loopTurnText(7, "every 1h", "do it").startsWith("[loop 7] Scheduled run (every 1h)")).toBe(true);
  });
});

describe("parseLoopArgs --name", () => {
  const ok = (r: ReturnType<typeof parseLoopArgs>) => {
    if (!r.ok) throw new Error(r.error);
    return r;
  };

  test("a quoted name sits between the schedule and the prompt", () => {
    const r = ok(parseLoopArgs('every 6h --name "PR board" check open PRs'));
    expect(r.name).toBe("PR board");
    expect(r.prompt).toBe("check open PRs");
    expect(r.schedule).toEqual({ kind: "interval", everyMs: 6 * 3_600_000 });
  });

  test("a single word, --name=word, single and smart quotes all work", () => {
    expect(ok(parseLoopArgs("every 6h --name board check")).name).toBe("board");
    expect(ok(parseLoopArgs("every 6h --name=board check")).name).toBe("board");
    expect(ok(parseLoopArgs("every 6h --name 'PR board' check")).name).toBe("PR board");
    const smart = ok(parseLoopArgs("every monday 9am --name “PR board” check"));
    expect(smart.name).toBe("PR board");
    expect(smart.prompt).toBe("check");
  });

  test("with no name it is derived from the prompt", () => {
    const r = ok(parseLoopArgs("every 6h check the open pull requests daily"));
    expect(r.name).toBe("check the open pull");
    expect(r.prompt).toBe("check the open pull requests daily");
  });

  test("a blank name falls back to the derived one", () => {
    expect(ok(parseLoopArgs('every 6h --name "" check the queue')).name).toBe("check the queue");
  });

  test("the name is made Slack-safe", () => {
    expect(ok(parseLoopArgs('every 6h --name "<!channel> *PR*" check')).name).toBe("channel PR");
  });

  test("an apostrophe inside a single-quoted name stays in the name, not the prompt", () => {
    const r = ok(parseLoopArgs("every 6h --name 'Kai's board' check the queue"));
    expect(r.name).toBe("Kai's board");
    expect(r.prompt).toBe("check the queue");
  });

  test("Slack-escaped input gives the same name as the brain's unescaped one", () => {
    expect(ok(parseLoopArgs('every 6h --name "Q&amp;A board" check')).name).toBe("Q A board");
    expect(ok(parseLoopArgs('every 6h --name "Q&A board" check')).name).toBe("Q A board");
  });

  test("a missing or unclosed name explains itself", () => {
    expect(parseLoopArgs("every 6h --name")).toEqual({ ok: false, error: 'say a name after `--name`, e.g. `--name "PR board"`' });
    expect(parseLoopArgs('every 6h --name "PR board check')).toEqual({ ok: false, error: "close the quote after `--name`" });
  });

  test("a name with no prompt still asks for the prompt", () => {
    expect(parseLoopArgs('every 6h --name "PR board"')).toEqual({ ok: false, error: "say what to do each time" });
  });

  test("a script loop takes a name too, and its command stays whole", () => {
    const r = ok(parseLoopArgs('every 15m --name "Sync" -- ./sync.sh --all'));
    expect(r.name).toBe("Sync");
    expect(r.command).toBe("./sync.sh --all");
    expect(r.prompt).toBe("");
    expect(ok(parseLoopArgs("every 15m -- ./sync.sh --all")).name).toBe("./sync.sh --all");
  });

  test("a prompt that merely mentions --name later is not a name", () => {
    const r = ok(parseLoopArgs("every 6h run the thing with --name x"));
    expect(r.prompt).toBe("run the thing with --name x");
    expect(r.name).toBe("run the thing with");
  });
});
