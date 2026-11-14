import { describe, expect, test } from "bun:test";
import { dispatchCommand, listCommandInfo, type CommandDeps } from "../../src/application/commands.ts";
import { createJourneyRepo } from "../../src/infrastructure/db/journeyRepo.ts";
import { defaultGrants, seededBook } from "../../src/domain/roleSeed.ts";
import { PERM, permissionCatalogue } from "../../src/domain/permissions.ts";
import { OWNER, actor, build, db } from "./commandsFixture.ts";

const HOUR = 3_600_000;
const PR = "https://github.com/acme/widgets/pull/7";

/** Deps with a journeys repo and a clock the test moves. */
const setup = (start = 1_000_000_000) => {
  const base = build();
  const journeys = createJourneyRepo(db);
  const clock = { t: start };
  const deps: CommandDeps = {
    ...base,
    journeys,
    clock: () => clock.t,
    roles: seededBook({ commands: listCommandInfo().map((c) => ({ name: c.name, minRole: c.minRole })) }),
  };
  return { deps, journeys, clock };
};

const run = (deps: CommandDeps, line: string, who = actor(), threadTs?: string) =>
  dispatchCommand(deps, who, "C1", line, { fromBrainRun: true, ...(threadTs ? { threadTs } : {}) });

/** What a person typing the line gets: no run bridge behind it. */
const typed = (deps: CommandDeps, line: string, who = actor()) => dispatchCommand(deps, who, "C1", line);

describe("journey command", () => {
  test("add opens a doing journey with its event, and links the thread it was typed in", async () => {
    const { deps, journeys } = setup();
    const permalinks: string[] = [];
    const withLink = { ...deps, slack: { ...deps.slack!, permalink: async (c: string, ts: string) => (permalinks.push(`${c}/${ts}`), "https://slack.test/p1") } };
    const out = await run(withLink, 'journey add Fix the login bug --area Jarvis --now "reading the stack trace" --next "write a test"', actor(), "9.9");
    expect(out).toContain("journey #1");
    const j = journeys.get(1)!;
    expect(j).toMatchObject({ title: "Fix the login bug", status: "doing", area: "Jarvis", now: "reading the stack trace", next: "write a test", threadTs: "9.9", channelId: "C1", permalink: "https://slack.test/p1", createdBy: OWNER });
    expect(permalinks).toEqual(["C1/9.9"]);
    expect(journeys.events(1).map((e) => e.kind)).toEqual(["created"]);
  });

  test("add outside a thread keeps the channel and no thread", async () => {
    const { deps, journeys } = setup();
    await run(deps, "journey add Plan the migration --status planned");
    expect(journeys.get(1)).toMatchObject({ status: "planned", threadTs: "", channelId: "C1", permalink: "" });
  });

  test("a failing permalink lookup still saves the journey", async () => {
    const { deps, journeys } = setup();
    const broken = { ...deps, slack: { ...deps.slack!, permalink: async () => { throw new Error("slack down"); } } };
    const out = await run(broken, "journey add Survives", actor(), "9.9");
    expect(out).toContain("journey #1");
    expect(journeys.get(1)?.permalink).toBe("");
  });

  test("add needs a title, a real status and a PR url", async () => {
    const { deps, journeys } = setup();
    expect(await run(deps, "journey add")).toContain("What is it?");
    expect(await run(deps, "journey add x --status nope")).toContain("not a status");
    expect(await run(deps, "journey add x --pr https://example.com/a")).toContain("not a GitHub pull request url");
    expect(await run(deps, "journey add x --bogus 1")).toContain("do not know `--bogus`");
    expect(await run(deps, "journey add x --now")).toContain("needs a value");
    expect(journeys.list({})).toHaveLength(0);
  });

  test("update changes the fields and appends one event per change", async () => {
    const { deps, journeys, clock } = setup();
    await run(deps, "journey add Ship it");
    clock.t += HOUR;
    const out = await run(deps, `journey update 1 --progress 40% --now "review round 1" --pr ${PR} --note "waiting on CI"`);
    expect(out).toContain("40%");
    expect(journeys.get(1)).toMatchObject({ progress: 40, now: "review round 1", prs: [PR], updatedAt: clock.t });
    expect(journeys.events(1).map((e) => [e.kind, e.text])).toEqual([
      ["created", "doing: Ship it"],
      ["progress", "40%"],
      ["pr", PR],
      ["note", "now: review round 1"],
      ["note", "waiting on CI"],
    ]);
  });

  test("the same PR twice is kept once, and an update that changes nothing adds no event", async () => {
    const { deps, journeys } = setup();
    await run(deps, "journey add Ship it");
    await run(deps, `journey update 1 --pr <${PR}>`);
    await run(deps, `journey update 1 --pr ${PR} --progress 0`);
    expect(journeys.get(1)?.prs).toEqual([PR]);
    expect(journeys.events(1).filter((e) => e.kind === "pr")).toHaveLength(1);
    expect(journeys.events(1).filter((e) => e.kind === "progress")).toHaveLength(0);
  });

  test("update says what is wrong instead of guessing", async () => {
    const { deps } = setup();
    await run(deps, "journey add Ship it");
    expect(await run(deps, "journey update")).toContain("Which one?");
    expect(await run(deps, "journey update 1")).toContain("Change what?");
    expect(await run(deps, "journey update 1 --progress 140")).toContain("0 to 100");
    expect(await run(deps, "journey update 9 --progress 10")).toContain("no journey #9");
  });

  test("done finishes at 100% with a timestamp and a closing note; drop leaves done_at alone", async () => {
    const { deps, journeys, clock } = setup();
    await run(deps, "journey add One");
    await run(deps, "journey add Two");
    clock.t += HOUR;
    expect(await run(deps, "journey done 1 shipped and verified")).toContain("done");
    expect(journeys.get(1)).toMatchObject({ status: "done", progress: 100, doneAt: clock.t });
    expect(journeys.events(1).map((e) => [e.kind, e.text]).slice(-3)).toEqual([
      ["status", "doing -> done"],
      ["progress", "100%"],
      ["note", "shipped and verified"],
    ]);
    await run(deps, "journey drop #2 not needed any more");
    expect(journeys.get(2)).toMatchObject({ status: "dropped", doneAt: 0 });
    expect(journeys.events(2).at(-1)).toMatchObject({ kind: "note", text: "not needed any more" });
  });

  test("reopening a done journey clears its finish time", async () => {
    const { deps, journeys } = setup();
    await run(deps, "journey add One");
    await run(deps, "journey done 1");
    await run(deps, "journey update 1 --status doing");
    expect(journeys.get(1)).toMatchObject({ status: "doing", doneAt: 0 });
  });

  test("list shows the open ones by default, by status, by area and since a span", async () => {
    const { deps, clock } = setup();
    await run(deps, "journey add Old one --area Jarvis");
    clock.t += 10 * 24 * HOUR;
    await run(deps, "journey add Planned one --status planned --area Ops");
    await run(deps, "journey add Finished one");
    await run(deps, "journey done 3");
    clock.t += HOUR;
    const open = await run(deps, "journey list");
    expect(open).toContain("Old one");
    expect(open).toContain("Planned one");
    expect(open).not.toContain("Finished one");
    expect(await run(deps, "journey list done")).toContain("Finished one");
    expect(await run(deps, "journey list all")).toContain("Finished one");
    expect(await run(deps, "journey list --area ops")).toContain("Planned one");
    expect(await run(deps, "journey list --area ops")).not.toContain("Old one");
    const recent = await run(deps, "journey list --since 7d");
    expect(recent).toContain("Planned one");
    expect(recent).not.toContain("Old one");
    expect(await run(deps, "journey list dropped")).toBe("No dropped journeys.");
    expect(await run(deps, "journey list bogus")).toContain("not a status");
    expect(await run(deps, "journey list --since soon")).toContain("span");
  });

  test("list with nothing open says so, and a bare `journey` is the list", async () => {
    const { deps } = setup();
    expect(await run(deps, "journey")).toBe("No open journeys.");
  });

  test("show gives the fields and the trail, and refuses an unknown id", async () => {
    const { deps, clock } = setup();
    await run(deps, `journey add Ship it --area Jarvis --now "writing" --next "review" --pr ${PR}`);
    clock.t += 2 * HOUR;
    await run(deps, "journey update 1 --progress 60");
    const out = await run(deps, "journey show 1");
    expect(out).toContain("*#1 Ship it*");
    expect(out).toContain("doing 60% [Jarvis]");
    expect(out).toContain("*now:* writing");
    expect(out).toContain("*next:* review");
    expect(out).toContain(`*PRs:* ${PR}`);
    expect(out).toContain("progress: 60%");
    expect(out).toContain("2h00m ago");
    expect(await run(deps, "journey show 77")).toContain("no journey #77");
    expect(await run(deps, "journey show")).toContain("no journey with that id");
  });

  test("a title is flattened and clipped", async () => {
    const { deps, journeys } = setup();
    await run(deps, `journey add "${"x".repeat(300)}"`);
    expect(journeys.get(1)?.title).toHaveLength(120);
  });

  test("Slack markup never survives into a row, so a read cannot ping anyone", async () => {
    const { deps, journeys } = setup();
    await run(deps, 'journey add "ping <!channel> and <!here> and <@U0PAL0001> *bold* `code`" --area "<!everyone>" --now "see <https://x.test/a|the doc> &amp; more" --next "<!subteam^S1|team> go"');
    await run(deps, 'journey update 1 --note "<!channel> done" --title "<!channel> renamed"');
    const j = journeys.get(1)!;
    for (const text of [j.title, j.area, j.now, j.next, ...journeys.events(1).map((e) => e.text)]) {
      expect(text).not.toMatch(/[<>`*|]|&amp;|!channel|!here|!everyone/);
    }
    expect(j).toMatchObject({ area: "everyone", now: "see the doc more" });
    expect(j.title).toBe("channel renamed");
    const shown = await run(deps, "journey show 1");
    const listed = await run(deps, "journey list");
    for (const out of [shown, listed]) expect(out).not.toMatch(/<!|<@U0PAL/);
  });

  test("a single-quoted value may hold an apostrophe", async () => {
    const { deps, journeys } = setup();
    await run(deps, "journey add Fix --now 'it's broken' --next 'Kai's call'");
    expect(journeys.get(1)).toMatchObject({ title: "Fix", now: "it's broken", next: "Kai's call" });
  });

  test("an empty value clears now, next and area; the trail says so", async () => {
    const { deps, journeys } = setup();
    await run(deps, 'journey add Ship --area Ops --now "writing" --next "review"');
    await run(deps, 'journey update 1 --now "" --next= --area ""');
    expect(journeys.get(1)).toMatchObject({ now: "", next: "", area: "" });
    expect(journeys.events(1).map((e) => e.text)).toEqual(expect.arrayContaining(["now: (cleared)", "next: (cleared)", "area: (cleared)"]));
    expect(await run(deps, 'journey update 1 --status ""')).toContain("needs a value");
  });

  test("title, area and next changes each leave an event", async () => {
    const { deps, journeys } = setup();
    await run(deps, "journey add Ship");
    await run(deps, 'journey update 1 --title "Ship v2" --area Ops --next "tag it"');
    expect(journeys.events(1).map((e) => e.text).slice(1)).toEqual(["title: Ship v2", "area: Ops", "next: tag it"]);
  });

  test("add refuses --title instead of ignoring it, and an eleventh PR is said out loud", async () => {
    const { deps, journeys } = setup();
    expect(await run(deps, "journey add x --title y")).toContain("--title");
    expect(journeys.list({ statuses: [] })).toHaveLength(0);
    await run(deps, "journey add Many");
    for (let n = 1; n <= 10; n++) await run(deps, `journey update 1 --pr https://github.com/a/b/pull/${n}`);
    expect(journeys.get(1)?.prs).toHaveLength(10);
    expect(await run(deps, "journey update 1 --pr https://github.com/a/b/pull/11")).toContain("already lists 10 PRs");
    expect(journeys.get(1)?.prs).toHaveLength(10);
    // a PR it already has is not a new one
    expect(await run(deps, "journey update 1 --pr https://github.com/a/b/pull/3")).toContain("#1");
  });

  test("a typed line is refused for every role, the owner included, and changes nothing", async () => {
    const { deps, journeys } = setup();
    await run(deps, "journey add Mine");
    const roles = ["pal", "executer", "admin", "owner"] as const;
    for (const role of roles) {
      const who = actor({ slackId: `U-${role}`, role });
      for (const line of ["journey list", "journey show 1", "journey help", "journey add Nope", "journey update 1 --progress 9", "journey done 1", "journey drop 1", "journeys list"]) {
        expect(await typed(deps, line, who)).toContain("is internal");
      }
    }
    expect(journeys.list({ statuses: [] })).toHaveLength(1);
    expect(journeys.get(1)?.status).toBe("doing");
  });

  test("my own turn runs it whoever it talks to, with no grant needed", async () => {
    const { deps, journeys } = setup();
    for (const role of ["pal", "executer", "admin", "owner"] as const) {
      const who = actor({ slackId: `U-${role}`, role });
      expect(await run(deps, `journey add From a ${role} thread`, who)).toContain("journey #");
      expect(await run(deps, "journey list", who)).toContain(`From a ${role} thread`);
    }
    expect(await run(deps, "journey update 1 --progress 40", actor({ role: "pal" }))).toContain("#1");
    expect(await run(deps, "journey done 1", actor({ role: "pal" }))).toContain("#1");
    expect(journeys.get(1)).toMatchObject({ status: "done", progress: 100, createdBy: "U-pal" });
  });

  test("a stored role that never held a journey grant still lets the turn run it", async () => {
    const { deps } = setup();
    const bare = { ...deps, roles: seededBook({ commands: [] }) };
    expect(await run(bare, "journey add No grant", actor({ role: "pal" }))).toContain("journey #1");
  });

  test("it is in no list a person reads: help, the dashboard commands, the grant catalogue", async () => {
    const { deps } = setup();
    for (const role of ["pal", "executer", "admin", "owner"] as const) {
      expect(await typed(deps, "help", actor({ role }))).not.toContain("journey");
    }
    expect(listCommandInfo().map((c) => c.name)).not.toContain("journey");
    expect(permissionCatalogue({ commands: listCommandInfo(), mcpServers: [] }).map((p) => p.id)).not.toContain("journeys:write");
    expect(Object.values(PERM)).not.toContain("journeys:write");
    for (const seed of ["pal", "executer", "admin"]) {
      const grants = defaultGrants(seed, { commands: listCommandInfo().map((c) => ({ name: c.name, minRole: c.minRole })), dbServers: [], executerDbServers: [], extraMcpServers: [] });
      expect(grants.filter((g) => g.includes("journey"))).toEqual([]);
    }
  });

  test("a near miss never suggests it", async () => {
    const { deps } = setup();
    expect(await typed(deps, "journy list")).not.toContain("journey");
  });

  test("help lists the subcommands and does not run anything", async () => {
    const { deps, journeys } = setup();
    const out = await run(deps, "journey help");
    expect(out).not.toContain("journeys:write");
    for (const word of ["add", "update", "done", "drop", "list", "show", "--since"]) expect(out).toContain(word);
    expect(journeys.list({ statuses: [] })).toHaveLength(0);
  });

  test("without a repo it says so", async () => {
    expect(await dispatchCommand(build(), actor(), "C1", "journey list", { fromBrainRun: true })).toContain("nowhere to keep journeys");
  });
});
