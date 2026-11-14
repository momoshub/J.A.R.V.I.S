import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createLoopRepo, type LoopRepo } from "../../src/infrastructure/db/loopRepo.ts";
import { createLoopRunner, type LoopTurnRequest } from "../../src/application/loops.ts";
import { dispatchCommand } from "../../src/application/commands.ts";
import { respond, type RespondDeps } from "../../src/application/respond.ts";
import type { CommandDeps } from "../../src/application/commands/shared.ts";
import type { CheckResult } from "../../src/application/watcher.ts";
import { createCommandLogRepo } from "../../src/infrastructure/db/commandLogRepo.ts";
import { decideLoop, expirePendingLoops, type LoopApprovalDeps } from "../../src/application/loopApproval.ts";
import { migrate } from "../../src/infrastructure/db/schema.ts";
import { approvalText, loopRef, LOOP_APPROVE_ACTION, LOOP_REJECT_ACTION, PENDING_TTL_MS } from "../../src/domain/loop.ts";
import { actor, build, db as fixtureDb, OWNER, slackCalls } from "./commandsFixture.ts";

let db: DbClient;
let loops: LoopRepo;
let now: number;
let turns: LoopTurnRequest[];
let dms: { userId: string; text: string }[];
let ran: string[];
let failDm = false;
/** What a held turn answers; undefined = a silent run. */
let reply: string | undefined;
let adopted: { from: { channel: string; ts: string }; to: { channel: string; ts: string } }[];
let check: CheckResult = { code: 0, output: "" };

const HOUR = 3_600_000;

/** Stands in for `chat.getPermalink`, which also adds `thread_ts` for a thread reply. */
const link = async (channel: string, ts: string): Promise<string | undefined> =>
  `https://team.slack.com/archives/${channel}/p${ts.replace(".", "")}`;

const runner = (
  over: { repo?: LoopRepo; mayRun?: (id: string, script: boolean) => boolean; noCheck?: boolean; turnFails?: boolean; permalink?: typeof link } = {},
) =>
  createLoopRunner({
    loops: over.repo ?? loops,
    clock: () => now,
    offsetMinutes: () => 0,
    runTurn: async (req) => {
      if (over.turnFails) throw new Error("queue closed");
      turns.push(req);
      return reply === undefined ? undefined : { text: reply };
    },
    openDm: async (userId) => (failDm ? undefined : `D-${userId}`),
    adopt: (from, to) => adopted.push({ from, to }),
    dm: async (userId, text) => {
      if (failDm) return undefined;
      dms.push({ userId, text });
      return { channel: `D-${userId}`, ts: `${dms.length}.000` };
    },
    check: over.noCheck
      ? undefined
      : async (cmd) => {
          ran.push(cmd);
          return check;
        },
    mayRun: over.mayRun,
    permalink: over.permalink,
  });

const add = (over: Partial<Parameters<LoopRepo["add"]>[0]> = {}) =>
  loops.add(
    {
      channelId: "C1",
      threadTs: "9.9",
      createdBy: "U1",
      schedule: "every 1h",
      prompt: "search for slang",
      command: "",
      nextAt: now + HOUR,
      ...over,
    },
    now,
  );

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  db = openDatabase(":memory:");
  loops = createLoopRepo(db);
  now = Date.UTC(2026, 10, 5, 10, 0);
  turns = [];
  dms = [];
  ran = [];
  failDm = false;
  reply = "found 3 new words";
  adopted = [];
  check = { code: 0, output: "" };
});

const shownOf = (row: { id: number; schedule: string; command?: string | null }): string[] => [approvalText(row.id, row.schedule, row.command ?? "")];

describe("loop runner: prompt mode", () => {
  test("nothing fires before it is due", async () => {
    add();
    await runner().tick();
    expect(turns).toHaveLength(0);
  });

  test("fires in the creator's DM under a made-up thread, not in its origin thread", async () => {
    const l = add();
    now += HOUR;
    await runner().tick();
    await flush();
    expect(turns).toEqual([
      {
        channelId: "D-U1",
        threadTs: expect.stringMatching(/^\d+\.\d{6}$/),
        slackUserId: "U1",
        text: expect.stringContaining(`[loop ${l.id}]`),
        unprompted: true,
        loop: true,
        hold: true,
      },
    ]);
    expect(turns[0]?.text).toContain("search for slang");
    expect(turns[0]?.channelId).not.toBe("C1");
  });

  test("a silent run leaves nothing in Slack: no header, no reply, nothing adopted", async () => {
    reply = undefined;
    const l = add();
    now += HOUR;
    await runner().tick();
    await flush();
    expect(turns).toHaveLength(1);
    expect(dms).toHaveLength(0);
    expect(adopted).toHaveLength(0);
    expect(loops.get(l.id)?.state).toBe("active");
  });

  test("a blank reply is silent too", async () => {
    reply = "  \n";
    add();
    now += HOUR;
    await runner().tick();
    await flush();
    expect(dms).toHaveLength(0);
  });

  test("a run that answers posts ONE top-level DM, header then reply, and its session follows", async () => {
    reply = "found 3 new words: a, b, c";
    const l = add({ name: "Slang" });
    now += HOUR;
    await runner().tick();
    await flush();
    expect(dms).toEqual([{ userId: "U1", text: `🔁 Slang - loop #${l.id}, every 1h\n\nfound 3 new words: a, b, c` }]);
    expect(adopted).toEqual([
      { from: { channel: "D-U1", ts: turns[0]!.threadTs }, to: { channel: "D-U1", ts: "1.000" } },
    ]);
  });

  test("a reply that cannot be posted is logged and does not fail the loop", async () => {
    const l = add();
    now += HOUR;
    const r = createLoopRunner({
      loops,
      clock: () => now,
      offsetMinutes: () => 0,
      runTurn: async () => ({ text: "hello" }),
      openDm: async () => "D-U1",
      dm: async () => {
        throw new Error("slack down");
      },
      adopt: (from, to) => adopted.push({ from, to }),
    });
    await r.tick();
    await flush();
    expect(adopted).toHaveLength(0);
    expect(loops.get(l.id)?.state).toBe("active");
    expect(loops.get(l.id)?.lastError ?? "").not.toContain("could not start");
  });

  test("the fire header and the turn carry the name", async () => {
    const l = add({ name: "PR board" });
    now += HOUR;
    await runner().tick();
    await flush();
    expect(dms[0]?.text).toBe(`🔁 PR board - loop #${l.id}, every 1h\n\nfound 3 new words`);
    expect(turns[0]?.text).toContain('Scheduled run of "PR board"');
  });

  test("a loop nobody named reads as the first words of its prompt", async () => {
    const l = add({ prompt: "search for slang and update my learning" });
    expect(l.name).toBe("search for slang and");
    now += HOUR;
    await runner().tick();
    await flush();
    expect(dms[0]?.text).toContain(`🔁 search for slang and - loop #${l.id}, every 1h`);
  });

  test("a stopped loop says which loop", async () => {
    const stopped = add({ name: "Old one" });
    now += HOUR;
    await runner({ mayRun: () => false }).tick();
    expect(dms.at(-1)?.text).toBe(`Stopped Old one - loop #${stopped.id}: whoever set it is no longer allowed to run it.`);
  });

  test("a turn that fails to start says which loop", async () => {
    const l = add({ name: "PR board" });
    now += HOUR;
    await runner({ turnFails: true }).tick();
    await flush();
    expect(dms.at(-1)?.text).toBe(`PR board - loop #${l.id}: could not start its turn: queue closed`);
  });

  test("every fire opens a new DM thread, so runs do not pile up", async () => {
    add();
    const r = runner();
    now += HOUR;
    await r.tick();
    now += HOUR;
    await r.tick();
    await flush();
    expect(new Set(turns.map((t) => t.threadTs)).size).toBe(2);
  });

  test("is moved on from now, and counted", async () => {
    const l = add();
    now += HOUR;
    await runner().tick();
    const after = loops.get(l.id);
    expect(after?.nextAt).toBe(now + HOUR);
    expect(after?.runs).toBe(1);
    expect(after?.lastRunAt).toBe(now);
  });

  test("missed fires while down run ONCE on the first tick, never a backlog", async () => {
    const l = add({ schedule: "every 1h" });
    now += 50 * HOUR;
    const r = runner();
    await r.tick();
    await r.tick();
    expect(turns).toHaveLength(1);
    expect(loops.get(l.id)?.nextAt).toBe(now + HOUR);
  });

  test("a missed daily slot also runs once and lands on the next slot", async () => {
    const l = add({ schedule: "every day at 18:00", nextAt: Date.UTC(2026, 10, 5, 18) });
    now = Date.UTC(2026, 10, 8, 12);
    await runner().tick();
    expect(turns).toHaveLength(1);
    expect(loops.get(l.id)?.nextAt).toBe(Date.UTC(2026, 10, 8, 18));
  });

  test("a cancelled loop never fires", async () => {
    const l = add();
    loops.settle(l.id, "cancelled", now);
    now += HOUR;
    await runner().tick();
    expect(turns).toHaveLength(0);
  });

  test("a creator who is no longer allowed is stopped with a DM, no turn", async () => {
    const l = add();
    now += HOUR;
    await runner({ mayRun: () => false }).tick();
    expect(turns).toHaveLength(0);
    expect(loops.get(l.id)?.state).toBe("failed");
    expect(dms[0]?.text).toContain("no longer allowed");
  });

  test("no DM to post under means no turn, and it stays scheduled", async () => {
    const l = add();
    now += HOUR;
    failDm = true;
    await runner().tick();
    expect(turns).toHaveLength(0);
    expect(loops.get(l.id)?.state).toBe("active");
    expect(loops.get(l.id)?.lastError).toContain("DM");
  });

  test("a turn that fails to start says so in the DM and the loop lives on", async () => {
    const l = add();
    now += HOUR;
    await runner({ turnFails: true }).tick();
    await flush();
    expect(dms.some((d) => d.text.includes("could not start its turn"))).toBe(true);
    expect(loops.get(l.id)?.state).toBe("active");
  });
});

describe("loop runner: origin link", () => {
  test("the announcement links back to the message that created the loop", async () => {
    const l = add({ threadTs: "", originTs: "5.250" });
    now += HOUR;
    await runner({ permalink: link }).tick();
    await flush();
    expect(dms[0]?.text).toContain(`🔁 search for slang - loop #${l.id}, every 1h · <https://team.slack.com/archives/C1/p5250|created here>\n\n`);
  });

  test("a loop made in a thread links to its own message there, not the thread root", async () => {
    const seen: string[] = [];
    add({ threadTs: "4.100", originTs: "5.250" });
    now += HOUR;
    await runner({ permalink: async (c, ts) => (seen.push(`${c} ${ts}`), link(c, ts)) }).tick();
    expect(seen).toEqual(["C1 5.250"]);
  });

  test("a loop with no origin message falls back to its thread, and with neither says nothing extra", async () => {
    add({ threadTs: "4.100" });
    add({ threadTs: "" });
    now += HOUR;
    await runner({ permalink: link }).tick();
    await flush();
    expect(dms[0]?.text).toContain("<https://team.slack.com/archives/C1/p4100|created here>");
    expect(dms[1]?.text).not.toContain("created here");
  });

  test("no link is no reason to skip a run: a failing or missing permalink leaves the plain header", async () => {
    const l = add({ originTs: "5.250" });
    add({ originTs: "5.251" });
    now += HOUR;
    await runner({ permalink: async () => { throw new Error("ratelimited"); } }).tick();
    await flush();
    expect(dms[0]?.text).toContain(`🔁 search for slang - loop #${l.id}, every 1h\n\n`);
    expect(turns).toHaveLength(2);
    now += HOUR;
    dms = [];
    await runner().tick();
    await flush();
    expect(dms[0]?.text).not.toContain("created here");
  });

  test("a script loop's failure line carries the same link", async () => {
    const l = add({ prompt: "", command: "./sync.sh", originTs: "5.250" });
    check = { code: 2, output: "boom" };
    now += HOUR;
    await runner({ permalink: link }).tick();
    await flush();
    expect(dms[0]?.text).toBe(`${loopRef(l.id, l.name)}: script failed: exit 2 - boom · <https://team.slack.com/archives/C1/p5250|created here>`);
  });
});

describe("loop runner: script mode", () => {
  test("runs the command with no turn and no message on success", async () => {
    add({ prompt: "", command: "./sync.sh", schedule: "every 5m", nextAt: now + 5 * 60_000 });
    now += 10 * 60_000;
    await runner().tick();
    await flush();
    expect(ran).toEqual(["./sync.sh"]);
    expect(turns).toHaveLength(0);
    expect(dms).toHaveLength(0);
  });

  test("a non-zero exit sends one short failure line to the creator's DM and the loop stays alive", async () => {
    const l = add({ prompt: "", command: "./sync.sh", schedule: "every 5m", nextAt: now + 5 * 60_000 });
    check = { code: 3, output: "boom\nlast line" };
    now += 10 * 60_000;
    await runner().tick();
    await flush();
    expect(dms).toHaveLength(1);
    expect(dms[0]?.userId).toBe("U1");
    expect(dms[0]?.text).toContain(`./sync.sh - loop #${l.id}: script failed: exit 3 - last line`);
    const after = loops.get(l.id);
    expect(after?.state).toBe("active");
    expect(after?.nextAt).toBe(now + 5 * 60_000);
  });

  test("a timeout or an unrunnable command is a failure line too", async () => {
    add({ prompt: "", command: "sleep 99", schedule: "every 5m", nextAt: now + 5 * 60_000 });
    check = { code: 124, output: "", error: "timed out after 30s" };
    now += 10 * 60_000;
    await runner().tick();
    await flush();
    expect(dms[0]?.text).toContain("timed out");
  });

  test("a script loop whose creator is no longer the owner is stopped before it runs", async () => {
    const l = add({ prompt: "", command: "./sync.sh", schedule: "every 5m", nextAt: now + 5 * 60_000, createdBy: "U2" });
    now += 10 * 60_000;
    await runner({ mayRun: (_id, script) => !script }).tick();
    expect(ran).toHaveLength(0);
    expect(loops.get(l.id)?.state).toBe("failed");
  });

  test("with no shell runner wired it fails loudly instead of doing nothing", async () => {
    add({ prompt: "", command: "./sync.sh", schedule: "every 5m", nextAt: now + 5 * 60_000 });
    now += 10 * 60_000;
    await runner({ noCheck: true }).tick();
    await flush();
    expect(dms[0]?.text).toContain("no shell runner");
  });
});

describe("loop command", () => {
  const ADMIN = actor({ slackId: "U0ADMIN0001", role: "admin" });
  const OWNER_ACTOR = actor();

  /** Fresh deps; the loop repo shares the fixture's database. */
  const mk = () => {
    const base = build();
    const l = createLoopRepo(fixtureDb);
    const commandLog = createCommandLogRepo(fixtureDb);
    const clock = { now: 42 };
    const loopApproval: LoopApprovalDeps = {
      loops: l,
      slack: base.slack,
      clock: () => clock.now,
      ownerSlackId: OWNER,
      offsetMinutes: () => 0,
      timer: () => {},
    };
    return { deps: { ...base, clock: () => clock.now, loops: l, loopApproval, commandLog, tzOffsetMinutes: () => 0 }, l, commandLog, loopApproval, clock };
  };

  /** A turn's script loop for the owner, left pending. */
  const propose = async (m: ReturnType<typeof mk>, line = "loop every 15m -- ./sync.sh") => {
    await dispatchCommand(m.deps, OWNER_ACTOR, "C1", line, { fromBrainRun: true });
    return m.l.pending()[0]!;
  };

  test("an admin creates a prompt loop from a channel and gets a short confirmation there", async () => {
    const { deps, l } = mk();
    const out = await dispatchCommand(deps, ADMIN, "C1", "loop every 6h check the queue");
    expect(out).toContain("loop #");
    expect(out).toContain("every 6h");
    expect(out).toContain("your DM");
    const [row] = l.active();
    expect(row?.createdBy).toBe(ADMIN.slackId);
    expect(row?.prompt).toBe("check the queue");
    expect(row?.command).toBe("");
    expect(row?.nextAt).toBe(42 + 6 * HOUR);
  });

  test("pal and executer are refused, nothing stored", async () => {
    const { deps, l } = mk();
    for (const role of ["pal", "executer"] as const) {
      const out = await dispatchCommand(deps, actor({ slackId: "U0TEST00001", role }), "C1", "loop every 6h check");
      expect(out).toContain("needs *admin* access");
    }
    expect(l.active()).toHaveLength(0);
  });

  test("a typed script loop is refused for everyone, the owner included, and stores nothing", async () => {
    const { deps, l } = mk();
    for (const who of [ADMIN, OWNER_ACTOR]) {
      const out = await dispatchCommand(deps, who, "C1", "loop every 15m -- ./sync.sh");
      expect(out).toContain("never made from a typed line");
      expect(out).toContain("plain words");
    }
    expect(l.active()).toHaveLength(0);
    expect(l.pending()).toHaveLength(0);
    expect(slackCalls.buttons).toHaveLength(0);
  });

  test("a script loop from a turn is refused for a non-owner, and stores nothing", async () => {
    const { deps, l } = mk();
    const out = await dispatchCommand(deps, ADMIN, "C1", "loop every 15m -- ./sync.sh", { fromBrainRun: true });
    expect(out).toContain("only the owner");
    expect(l.liveBy(ADMIN.slackId)).toHaveLength(0);
    expect(slackCalls.buttons).toHaveLength(0);
  });

  test("a script loop from the owner's turn is stored PENDING and DMed with the exact command and Approve / Reject", async () => {
    const m = mk();
    const out = await dispatchCommand(m.deps, OWNER_ACTOR, "C1", "loop every 15m -- ./sync.sh --all", { fromBrainRun: true });
    expect(out).toContain("PENDING");
    expect(m.l.active()).toHaveLength(0);
    const row = m.l.pending()[0]!;
    expect(row.command).toBe("./sync.sh --all");
    expect(row.state).toBe("pending");
    const dm = slackCalls.posts.at(-1)!;
    expect(dm.channel).toBe(OWNER);
    expect(dm.text).toContain("./sync.sh --all");
    expect(dm.text).toContain("every 15m");
    expect(slackCalls.buttons).toEqual([`${LOOP_APPROVE_ACTION}:${row.id}`, `${LOOP_REJECT_ACTION}:${row.id}`]);
    expect(row.noticeTs).not.toBe("");
  });

  test("a turn's prompt loop is unchanged: active at once, no buttons", async () => {
    const { deps, l } = mk();
    expect(await dispatchCommand(deps, OWNER_ACTOR, "C1", "loop every 6h check slang", { fromBrainRun: true })).toContain("loop #");
    expect(l.active()).toHaveLength(1);
    expect(slackCalls.buttons).toHaveLength(0);
  });

  test("no way to DM the approval means no loop is kept", async () => {
    const m = mk();
    const deps = { ...m.deps, loopApproval: { ...m.loopApproval, slack: { ...m.deps.slack!, postDmInteractive: async () => undefined } } };
    const out = await dispatchCommand(deps, OWNER_ACTOR, "C1", "loop every 15m -- ./sync.sh", { fromBrainRun: true });
    expect(out).toContain("no script loop was created");
    expect(m.l.pending()).toHaveLength(0);
  });

  test("a bad schedule explains itself and stores nothing", async () => {
    const { deps, l } = mk();
    const out = await dispatchCommand(deps, ADMIN, "C1", "loop every 10m too fast");
    expect(out).toContain("shortest loop");
    expect(l.active()).toHaveLength(0);
  });

  test("list shows id, mode, schedule, next run and prompt; cancel is the creator's or the owner's", async () => {
    const { deps, l } = mk();
    await dispatchCommand(deps, ADMIN, "C1", "loop every monday 9am search slang");
    const [row] = l.active();
    const list = await dispatchCommand(deps, ADMIN, "C1", "loop list");
    expect(list).toContain(`#${row?.id}`);
    expect(list).toContain("prompt");
    expect(list).toContain("every monday at 09:00");
    expect(list).toContain("search slang");
    expect(list).toMatch(/next \w{3} \d\d\/\d\d 09:00/);

    const other = actor({ slackId: "U0ADMIN0002", role: "admin" });
    expect(await dispatchCommand(deps, other, "C1", `loop cancel ${row?.id}`)).toContain("not yours");
    expect(await dispatchCommand(deps, ADMIN, "C1", `loop cancel ${row?.id}`)).toContain("cancelled");
    expect(l.active()).toHaveLength(0);
    expect(await dispatchCommand(deps, ADMIN, "C1", `loop cancel ${row?.id}`)).toContain("no active loop");
  });

  test("a loop remembers the message that created it, and the thread it sat in", async () => {
    const { deps, l } = mk();
    await dispatchCommand(deps, ADMIN, "C1", "loop every 6h check the queue", { threadTs: "7.100", messageTs: "7.250" });
    await dispatchCommand(deps, ADMIN, "C1", "loop every 6h top level one", { messageTs: "8.300" });
    await dispatchCommand(deps, ADMIN, "C1", "loop every 6h from a slash command");
    const [inThread, topLevel, slash] = l.active().sort((a, b) => a.id - b.id);
    expect([inThread?.channelId, inThread?.threadTs, inThread?.originTs]).toEqual(["C1", "7.100", "7.250"]);
    expect([topLevel?.threadTs, topLevel?.originTs]).toEqual(["", "8.300"]);
    expect(slash?.originTs).toBe("");
  });

  test("through respond, a typed loop stores its message's ts and a slash command stores none", async () => {
    const m = mk();
    const deps = { ...m.deps, commandPrefix: "X/jv", slashCommand: "/jv" } as CommandDeps & RespondDeps;
    deps.users.upsert({ slackId: ADMIN.slackId, role: "admin", displayName: "Adm", addedBy: "x", createdAt: 1 });
    await respond(deps, { channelId: "C1", slackUserId: ADMIN.slackId, text: "X/jv loop every 6h typed one", threadTs: "7.100", messageTs: "7.250", viaSlash: false });
    await respond(deps, { channelId: "C1", slackUserId: ADMIN.slackId, text: "X/jv loop every 6h slash one", threadTs: "7.100", messageTs: "7.300", viaSlash: true });
    const [typed, slash] = m.l.active().sort((a, b) => a.id - b.id);
    expect([typed?.threadTs, typed?.originTs]).toEqual(["7.100", "7.250"]);
    expect([slash?.threadTs, slash?.originTs]).toEqual(["", ""]);
  });

  test("a script loop from a turn is stored with its origin too", async () => {
    const m = mk();
    await dispatchCommand(m.deps, OWNER_ACTOR, "C1", "loop every 15m -- ./sync.sh", { fromBrainRun: true, messageTs: "7.250" });
    expect(m.l.pending()[0]?.originTs).toBe("7.250");
  });

  test("list shows the origin link per loop, and nothing for one without an origin", async () => {
    const { deps, l } = mk();
    const withLink = { ...deps, slack: { ...deps.slack!, permalink: link } };
    await dispatchCommand(withLink, ADMIN, "C1", "loop every 6h linked one", { threadTs: "7.100", messageTs: "7.250" });
    await dispatchCommand(withLink, ADMIN, "C1", "loop every 6h bare one");
    const lines = (await dispatchCommand(withLink, ADMIN, "C1", "loop list")).split("\n");
    expect(lines[0]).toEndWith(" · <https://team.slack.com/archives/C1/p7250|created here>");
    expect(lines[1]).not.toContain("created here");
    expect(l.active()).toHaveLength(2);
    // Without a way to build a link the list is just as before.
    expect(await dispatchCommand(deps, ADMIN, "C1", "loop list")).not.toContain("created here");
  });

  test("a pending script loop in the list shows its origin too", async () => {
    const m = mk();
    await dispatchCommand(m.deps, OWNER_ACTOR, "C1", "loop every 15m -- ./sync.sh", { fromBrainRun: true, messageTs: "7.250" });
    const out = await dispatchCommand({ ...m.deps, slack: { ...m.deps.slack!, permalink: link } }, OWNER_ACTOR, "C1", "loop list");
    expect(out).toContain("pending");
    expect(out).toEndWith("<https://team.slack.com/archives/C1/p7250|created here>");
  });

  test("list shows a pending script loop as pending, then as a script once approved", async () => {
    const m = mk();
    const row = await propose(m);
    expect(await dispatchCommand(m.deps, OWNER_ACTOR, "C1", "loop list")).toMatch(/script every 15m - pending.*`\.\/sync\.sh`/);
    await decideLoop(m.loopApproval, { slackUserId: OWNER, actionId: LOOP_APPROVE_ACTION, value: String(row.id), channel: row.noticeChannel, messageTs: row.noticeTs, shown: shownOf(row) });
    expect(await dispatchCommand(m.deps, OWNER_ACTOR, "C1", "loop list")).toMatch(/script every 15m - next.*`\.\/sync\.sh`/);
  });

  test("cancelling a pending loop deletes it and kills its buttons", async () => {
    const m = mk();
    const row = await propose(m);
    expect(await dispatchCommand(m.deps, OWNER_ACTOR, "C1", `loop cancel ${row.id}`)).toContain("cancelled");
    expect(m.l.get(row.id)).toBeUndefined();
    expect(await decideLoop(m.loopApproval, { slackUserId: OWNER, actionId: LOOP_APPROVE_ACTION, value: String(row.id), channel: row.noticeChannel, messageTs: row.noticeTs, shown: shownOf(row) })).toEqual({ kind: "unknown" });
  });

  test("--name names a loop; the confirmation, list and cancel all show it", async () => {
    const { deps, l } = mk();
    const out = await dispatchCommand(deps, ADMIN, "C1", 'loop every 6h --name "PR board" check open PRs');
    const [row] = l.active();
    expect(row?.name).toBe("PR board");
    expect(row?.prompt).toBe("check open PRs");
    expect(out).toContain(`PR board - loop #${row?.id}`);
    expect(out).toContain("loop rename");
    expect(await dispatchCommand(deps, ADMIN, "C1", "loop list")).toContain(`#${row?.id} *PR board* prompt`);
    expect(await dispatchCommand(deps, ADMIN, "C1", `loop cancel ${row?.id}`)).toBe(`cancelled PR board - loop #${row?.id}`);
  });

  test("with no name the loop gets the first words of its prompt", async () => {
    const { deps, l } = mk();
    await dispatchCommand(deps, ADMIN, "C1", "loop every 6h check the queue and report");
    expect(l.active()[0]?.name).toBe("check the queue and");
  });

  test("a name typed in Slack's escaped form is stored as the words, for create and rename", async () => {
    const { deps, l } = mk();
    await dispatchCommand(deps, ADMIN, "C1", 'loop every 6h --name "Q&amp;A board" check');
    const row = l.active()[0]!;
    expect(row.name).toBe("Q A board");
    await dispatchCommand(deps, ADMIN, "C1", `loop rename ${row.id} R&lt;D&gt; team`);
    expect(l.get(row.id)?.name).toBe("R D team");
  });

  test("a prompt with a Slack link is named by the link's label", async () => {
    const { deps, l } = mk();
    await dispatchCommand(deps, ADMIN, "C1", "loop every 6h check <https://github.com/o/r/pulls|open PRs> today");
    expect(l.active()[0]?.name).toBe("check open PRs today");
  });

  test("a bad --name stores nothing", async () => {
    const { deps, l } = mk();
    expect(await dispatchCommand(deps, ADMIN, "C1", 'loop every 6h --name "oops check')).toContain("close the quote");
    expect(l.active()).toHaveLength(0);
  });

  test("rename changes the name of your loop, with or without quotes, and the next fire uses it", async () => {
    const { deps, l } = mk();
    await dispatchCommand(deps, ADMIN, "C1", "loop every 6h check the queue");
    const id = l.active()[0]!.id;
    expect(await dispatchCommand(deps, ADMIN, "C1", `loop rename ${id} PR board`)).toBe(
      `renamed check the queue - loop #${id} to PR board - loop #${id}`,
    );
    expect(l.get(id)?.name).toBe("PR board");
    expect(await dispatchCommand(deps, ADMIN, "C1", `loop rename #${id} "Review queue"`)).toContain("Review queue - loop #");
    expect(l.get(id)?.name).toBe("Review queue");
    expect(await dispatchCommand(deps, ADMIN, "C1", "loop list")).toContain("*Review queue*");
    // Slack-safe, like a name given at creation.
    await dispatchCommand(deps, ADMIN, "C1", `loop rename ${id} <!channel> *x*`);
    expect(l.get(id)?.name).not.toMatch(/[<>*]/);
  });

  test("rename refuses: someone else's loop, a missing name, a missing or settled loop", async () => {
    const { deps, l } = mk();
    await dispatchCommand(deps, ADMIN, "C1", "loop every 6h check the queue");
    const id = l.active()[0]!.id;
    const other = actor({ slackId: "U0ADMIN0002", role: "admin" });
    expect(await dispatchCommand(deps, other, "C1", `loop rename ${id} Mine`)).toContain("not yours to rename");
    expect(l.get(id)?.name).toBe("check the queue");
    expect(await dispatchCommand(deps, ADMIN, "C1", `loop rename ${id}`)).toContain("loop rename <id> <name>");
    expect(await dispatchCommand(deps, ADMIN, "C1", `loop rename ${id} ***`)).toContain("Say the new name");
    expect(await dispatchCommand(deps, ADMIN, "C1", "loop rename 999 x")).toContain("no active loop");
    // The owner may rename anyone's.
    expect(await dispatchCommand(deps, OWNER_ACTOR, "C1", `loop rename ${id} Owned`)).toContain("renamed");
    await dispatchCommand(deps, ADMIN, "C1", `loop cancel ${id}`);
    expect(await dispatchCommand(deps, ADMIN, "C1", `loop rename ${id} x`)).toContain("no active loop");
  });

  test("pal and executer cannot rename (the command is admin+)", async () => {
    const { deps } = mk();
    expect(await dispatchCommand(deps, actor({ slackId: "U0TEST00001", role: "pal" }), "C1", "loop rename 1 x")).toContain("needs *admin* access");
  });

  test("a named script loop from a turn shows its name in the pending reply and the approval DM", async () => {
    const m = mk();
    const out = await dispatchCommand(m.deps, OWNER_ACTOR, "C1", 'loop every 15m --name "Sync" -- ./sync.sh --all', { fromBrainRun: true });
    const row = m.l.pending()[0]!;
    expect(row.name).toBe("Sync");
    expect(row.command).toBe("./sync.sh --all");
    expect(out).toContain(`Sync - loop #${row.id}`);
    expect(slackCalls.posts.at(-1)?.text).toContain("name (chosen by the turn, not checked): Sync");
    expect(await dispatchCommand(m.deps, OWNER_ACTOR, "C1", "loop list")).toContain("*Sync* script");
  });

  describe("approval", () => {
    const press = (m: ReturnType<typeof mk>, id: number, actionId: string, by = OWNER) => {
      const row = m.l.get(id);
      return decideLoop(m.loopApproval, { slackUserId: by, actionId, value: String(id), channel: row?.noticeChannel, messageTs: row?.noticeTs, shown: row ? shownOf(row) : [] });
    };

    test("a press that is not on the untouched approval DM changes nothing", async () => {
      const m = mk();
      const row = await propose(m);
      const base = { slackUserId: OWNER, actionId: LOOP_APPROVE_ACTION, value: String(row.id) };
      // A button a turn posted somewhere else, carrying the right id and value.
      expect(await decideLoop(m.loopApproval, { ...base, channel: "C0OTHER", messageTs: "1.000001" })).toEqual({ kind: "forged" });
      expect(await decideLoop(m.loopApproval, { ...base, channel: row.noticeChannel, messageTs: "1.000001" })).toEqual({ kind: "forged" });
      expect(await decideLoop(m.loopApproval, base)).toEqual({ kind: "forged" });
      // The real DM, but edited after it was posted.
      expect(await decideLoop(m.loopApproval, { ...base, channel: row.noticeChannel, messageTs: row.noticeTs, shown: shownOf(row), edited: true })).toEqual({ kind: "forged" });
      // The real DM rewritten to show a harmless command, with no edited flag (Slack may not set one for the app's own update).
      const harmless = approvalText(row.id, row.schedule, "echo backup ok");
      expect(await decideLoop(m.loopApproval, { ...base, channel: row.noticeChannel, messageTs: row.noticeTs, shown: [harmless] })).toEqual({ kind: "forged" });
      expect(await decideLoop(m.loopApproval, { ...base, channel: row.noticeChannel, messageTs: row.noticeTs, shown: [] })).toEqual({ kind: "forged" });
      expect(await decideLoop(m.loopApproval, { ...base, actionId: LOOP_REJECT_ACTION, channel: "C0OTHER", messageTs: "1.000001" })).toEqual({ kind: "forged" });
      expect(m.l.get(row.id)?.state).toBe("pending");
      // What was really posted passes, as Slack hands the text back in the section.
      const posted = slackCalls.posts.filter((p) => p.text.includes(`#${row.id}`)).at(-1)?.text ?? "";
      expect(await decideLoop(m.loopApproval, { ...base, channel: row.noticeChannel, messageTs: row.noticeTs, shown: [posted] })).toEqual({ kind: "approved", id: row.id });
    });

    test("a pending loop never runs, even when its time has come", async () => {
      const m = mk();
      const row = await propose(m);
      now = Date.UTC(2026, 10, 5, 10, 0);
      m.l.reschedule(row.id, now - 1, now);
      ran = [];
      await runner({ repo: m.l }).tick();
      await flush();
      expect(ran).toHaveLength(0);
      expect(m.l.get(row.id)?.runs).toBe(0);
      expect(m.l.due(now)).toHaveLength(0);
      // The row really is overdue: only its state keeps it quiet.
      expect(m.l.get(row.id)?.nextAt).toBeLessThan(now);
    });

    test("the owner's Approve activates it, from now, and it then runs", async () => {
      const m = mk();
      const row = await propose(m);
      m.clock.now = 1000;
      expect(await press(m, row.id, LOOP_APPROVE_ACTION)).toEqual({ kind: "approved", id: row.id });
      const after = m.l.get(row.id)!;
      expect(after.state).toBe("active");
      expect(after.nextAt).toBe(1000 + 15 * 60_000);
      expect(slackCalls.settled.at(-1)?.text).toContain("approved");
      // And a second press changes nothing.
      expect(await press(m, row.id, LOOP_APPROVE_ACTION)).toEqual({ kind: "decided" });

      now = after.nextAt + 1;
      ran = [];
      await runner({ repo: m.l }).tick();
      await flush();
      expect(ran).toEqual(["./sync.sh"]);
    });

    describe("a named script loop's notices carry the name", () => {
      const named = (m: ReturnType<typeof mk>) => propose(m, "loop every 15m --name Sync -- ./sync.sh");

      test("approve", async () => {
        const m = mk();
        const row = await named(m);
        expect(row.name).toBe("Sync");
        await press(m, row.id, LOOP_APPROVE_ACTION);
        expect(slackCalls.settled.at(-1)?.text).toContain(`Sync - script loop #${row.id} approved`);
      });

      test("reject", async () => {
        const m = mk();
        const row = await named(m);
        await press(m, row.id, LOOP_REJECT_ACTION);
        expect(slackCalls.settled.at(-1)?.text).toContain(`Sync - script loop #${row.id} rejected`);
      });

      test("expiry", async () => {
        const m = mk();
        const row = await named(m);
        m.clock.now = 42 + PENDING_TTL_MS;
        await expirePendingLoops(m.loopApproval);
        expect(slackCalls.settled.at(-1)?.text).toContain(`Sync - script loop #${row.id} expired`);
      });
    });

    test("anyone but the owner pressing Approve or Reject changes nothing", async () => {
      const m = mk();
      const row = await propose(m);
      for (const a of [LOOP_APPROVE_ACTION, LOOP_REJECT_ACTION]) {
        expect(await press(m, row.id, a, "U0ADMIN0001")).toEqual({ kind: "refused" });
      }
      expect(m.l.get(row.id)?.state).toBe("pending");
    });

    test("Reject deletes it", async () => {
      const m = mk();
      const row = await propose(m);
      expect(await press(m, row.id, LOOP_REJECT_ACTION)).toEqual({ kind: "rejected", id: row.id });
      expect(m.l.get(row.id)).toBeUndefined();
      expect(slackCalls.settled.at(-1)?.text).toContain("rejected");
      expect(await press(m, row.id, LOOP_APPROVE_ACTION)).toEqual({ kind: "unknown" });
    });

    test("no answer in 24h deletes it: by sweep, and a late Approve cannot revive it", async () => {
      const m = mk();
      const row = await propose(m);
      m.clock.now = 42 + PENDING_TTL_MS - 1;
      expect(await expirePendingLoops(m.loopApproval)).toBe(0);
      expect(m.l.get(row.id)?.state).toBe("pending");
      m.clock.now = 42 + PENDING_TTL_MS;
      expect(await expirePendingLoops(m.loopApproval)).toBe(1);
      expect(m.l.get(row.id)).toBeUndefined();
      expect(slackCalls.settled.at(-1)?.text).toContain("expired");
      expect(await press(m, row.id, LOOP_APPROVE_ACTION)).toEqual({ kind: "unknown" });
    });

    test("an Approve pressed after 24h, before any sweep, deletes instead of activating", async () => {
      const m = mk();
      const row = await propose(m);
      m.clock.now = 42 + PENDING_TTL_MS + 5;
      expect(await press(m, row.id, LOOP_APPROVE_ACTION)).toEqual({ kind: "expired" });
      expect(m.l.get(row.id)).toBeUndefined();
      expect(m.l.active()).toHaveLength(0);
    });

    test("the runner's tick runs the sweep, so expiry survives a restart", async () => {
      const m = mk();
      const row = await propose(m);
      m.clock.now = 42 + PENDING_TTL_MS + 1;
      await createLoopRunner({
        loops: m.l,
        clock: () => m.clock.now,
        offsetMinutes: () => 0,
        runTurn: async () => {},
        openDm: async () => undefined,
        dm: async () => undefined,
        sweep: () => expirePendingLoops(m.loopApproval),
      }).tick();
      expect(m.l.get(row.id)).toBeUndefined();
    });

    test("a pending loop counts toward the per-person cap", async () => {
      const m = mk();
      for (let i = 0; i < 10; i++) await propose(m, `loop every ${i + 5}m -- ./s${i}.sh`);
      expect(await dispatchCommand(m.deps, OWNER_ACTOR, "C1", "loop every 6h x", { fromBrainRun: true })).toContain("already have 10");
    });
  });

  test("the owner can cancel anyone's", async () => {
    const { deps, l } = mk();
    await dispatchCommand(deps, ADMIN, "C1", "loop every 2h x");
    const [row] = l.active();
    expect(await dispatchCommand(deps, OWNER_ACTOR, "C1", `loop cancel ${row?.id}`)).toContain("cancelled");
  });

  test("an empty list says so", async () => {
    const { deps } = mk();
    expect(await dispatchCommand(deps, ADMIN, "C1", "loop list")).toContain("no loops");
  });

  test("it is audited in the command log, refusals included", async () => {
    const { deps, commandLog } = mk();
    await dispatchCommand(deps, ADMIN, "C1", "loop every 2h x");
    await dispatchCommand(deps, actor({ slackId: "U0TEST00001", role: "pal" }), "C1", "loop every 2h x");
    const rows = commandLog.recent(5).filter((r) => r.command === "loop");
    expect(rows.map((r) => r.ok).sort()).toEqual([false, true]);
  });

  test("loop help prints the card and runs nothing", async () => {
    const { deps, l } = mk();
    const out = await dispatchCommand(deps, ADMIN, "C1", "loop help");
    expect(out).toContain("loop");
    expect(l.active()).toHaveLength(0);
  });

  test("a creator may hold only so many", async () => {
    const { deps, l } = mk();
    for (let i = 0; i < 10; i++) await dispatchCommand(deps, ADMIN, "C1", `loop every 2h task ${i}`);
    expect(await dispatchCommand(deps, ADMIN, "C1", "loop every 2h one more")).toContain("already have 10");
    expect(l.active()).toHaveLength(10);
  });
});

describe("loop names in storage", () => {
  test("an old database gets the column with nothing rewritten, and its loops read by their prompt", () => {
    const old = openDatabase(":memory:");
    // Back to the v32 shape: a loops table with no `name`, holding rows people already made.
    old.exec("ALTER TABLE loops DROP COLUMN name");
    old.exec(
      `INSERT INTO loops (channel_id, thread_ts, created_by, schedule, prompt, command, next_at, created_at, updated_at)
       VALUES ('C1', '1.1', 'U1', 'every 1h', 'summarise the open pull requests for the team', '', 5, 1, 1),
              ('C1', '1.2', 'U1', 'every 5m', '', './sync.sh --all', 5, 1, 1)`,
    );
    old.exec("PRAGMA user_version = 32");
    migrate(old);
    migrate(old); // a rerun is a no-op
    expect(old.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBeGreaterThanOrEqual(33);
    const repo = createLoopRepo(old);
    expect(repo.get(1)?.name).toBe("summarise the open pull");
    expect(repo.get(2)?.name).toBe("./sync.sh --all");
    // The stored value stays empty until somebody names it.
    expect(old.query<{ name: string }, []>("SELECT name FROM loops WHERE id = 1").get()?.name).toBe("");
    expect(repo.rename(1, "PR board", 9)).toBe(true);
    expect(repo.get(1)?.name).toBe("PR board");
  });

  test("rename only touches a live loop and refuses a blank name", () => {
    const repo = createLoopRepo(openDatabase(":memory:"));
    const l = repo.add({ channelId: "C", threadTs: "", createdBy: "U1", schedule: "every 1h", prompt: "a b c d e", command: "", nextAt: 1 }, 1);
    expect(l.name).toBe("a b c d");
    expect(repo.rename(l.id, " * ", 2)).toBe(false);
    expect(repo.get(l.id)?.name).toBe("a b c d");
    repo.settle(l.id, "cancelled", 3);
    expect(repo.rename(l.id, "late", 4)).toBe(false);
    expect(repo.rename(404, "x", 4)).toBe(false);
  });
});

describe("loop origin in storage", () => {
  test("an old database gets the column with no origin, its loops read the same, and new ones store theirs", () => {
    const old = openDatabase(":memory:");
    old.exec("ALTER TABLE loops DROP COLUMN origin_ts");
    old.exec(
      `INSERT INTO loops (channel_id, thread_ts, created_by, name, schedule, prompt, command, next_at, created_at, updated_at)
       VALUES ('C1', '1.1', 'U1', 'PR board', 'every 1h', 'summarise', '', 5, 1, 1)`,
    );
    old.exec("PRAGMA user_version = 35");
    migrate(old);
    migrate(old); // a rerun is a no-op
    expect(old.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBeGreaterThanOrEqual(36);
    const repo = createLoopRepo(old);
    expect(repo.get(1)?.originTs).toBe("");
    expect(repo.get(1)?.threadTs).toBe("1.1");
    const l = repo.add({ channelId: "C1", threadTs: "", createdBy: "U1", schedule: "every 1h", prompt: "x", command: "", nextAt: 9, originTs: "2.5" }, 1);
    expect(repo.get(l.id)?.originTs).toBe("2.5");
  });

  test("an old loop with no origin and no thread still fires, with the plain header", async () => {
    const l = add({ threadTs: "" });
    expect(l.originTs).toBe("");
    now += HOUR;
    await runner({ permalink: link }).tick();
    await flush();
    expect(dms[0]?.text).toBe(`🔁 search for slang - loop #${l.id}, every 1h\n\nfound 3 new words`);
  });
});
