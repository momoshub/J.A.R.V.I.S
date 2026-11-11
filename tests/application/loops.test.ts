import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createLoopRepo, type LoopRepo } from "../../src/infrastructure/db/loopRepo.ts";
import { createLoopRunner, type LoopTurnRequest } from "../../src/application/loops.ts";
import { dispatchCommand } from "../../src/application/commands.ts";
import type { CheckResult } from "../../src/application/watcher.ts";
import { createCommandLogRepo } from "../../src/infrastructure/db/commandLogRepo.ts";
import { decideLoop, expirePendingLoops, type LoopApprovalDeps } from "../../src/application/loopApproval.ts";
import { LOOP_APPROVE_ACTION, LOOP_REJECT_ACTION, PENDING_TTL_MS } from "../../src/domain/loop.ts";
import { actor, build, db as fixtureDb, OWNER, slackCalls } from "./commandsFixture.ts";

let db: DbClient;
let loops: LoopRepo;
let now: number;
let turns: LoopTurnRequest[];
let dms: { userId: string; text: string }[];
let ran: string[];
let failDm = false;
let check: CheckResult = { code: 0, output: "" };

const HOUR = 3_600_000;

const runner = (over: { repo?: LoopRepo; mayRun?: (id: string, script: boolean) => boolean; noCheck?: boolean; turnFails?: boolean } = {}) =>
  createLoopRunner({
    loops: over.repo ?? loops,
    clock: () => now,
    offsetMinutes: () => 0,
    runTurn: async (req) => {
      if (over.turnFails) throw new Error("queue closed");
      turns.push(req);
    },
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
  check = { code: 0, output: "" };
});

describe("loop runner: prompt mode", () => {
  test("nothing fires before it is due", async () => {
    add();
    await runner().tick();
    expect(turns).toHaveLength(0);
  });

  test("fires in the creator's DM as a fresh top-level message, not in its origin thread", async () => {
    const l = add();
    now += HOUR;
    await runner().tick();
    expect(dms).toHaveLength(1);
    expect(dms[0]?.userId).toBe("U1");
    expect(turns).toEqual([
      {
        channelId: "D-U1",
        threadTs: "1.000",
        slackUserId: "U1",
        text: expect.stringContaining(`[loop ${l.id}]`),
        unprompted: true,
      },
    ]);
    expect(turns[0]?.text).toContain("search for slang");
    expect(turns[0]?.channelId).not.toBe("C1");
  });

  test("every fire opens a new DM thread, so runs do not pile up", async () => {
    add();
    const r = runner();
    now += HOUR;
    await r.tick();
    now += HOUR;
    await r.tick();
    expect(turns.map((t) => t.threadTs)).toEqual(["1.000", "2.000"]);
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
    expect(dms[0]?.text).toContain(`Loop #${l.id} script failed: exit 3 - last line`);
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

  test("list shows a pending script loop as pending, then as a script once approved", async () => {
    const m = mk();
    const row = await propose(m);
    expect(await dispatchCommand(m.deps, OWNER_ACTOR, "C1", "loop list")).toMatch(/script every 15m - pending.*`\.\/sync\.sh`/);
    await decideLoop(m.loopApproval, { slackUserId: OWNER, actionId: LOOP_APPROVE_ACTION, value: String(row.id), channel: row.noticeChannel, messageTs: row.noticeTs });
    expect(await dispatchCommand(m.deps, OWNER_ACTOR, "C1", "loop list")).toMatch(/script every 15m - next.*`\.\/sync\.sh`/);
  });

  test("cancelling a pending loop deletes it and kills its buttons", async () => {
    const m = mk();
    const row = await propose(m);
    expect(await dispatchCommand(m.deps, OWNER_ACTOR, "C1", `loop cancel ${row.id}`)).toContain("cancelled");
    expect(m.l.get(row.id)).toBeUndefined();
    expect(await decideLoop(m.loopApproval, { slackUserId: OWNER, actionId: LOOP_APPROVE_ACTION, value: String(row.id), channel: row.noticeChannel, messageTs: row.noticeTs })).toEqual({ kind: "unknown" });
  });

  describe("approval", () => {
    const press = (m: ReturnType<typeof mk>, id: number, actionId: string, by = OWNER) => {
      const row = m.l.get(id);
      return decideLoop(m.loopApproval, { slackUserId: by, actionId, value: String(id), channel: row?.noticeChannel, messageTs: row?.noticeTs });
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
      expect(await decideLoop(m.loopApproval, { ...base, channel: row.noticeChannel, messageTs: row.noticeTs, edited: true })).toEqual({ kind: "forged" });
      expect(await decideLoop(m.loopApproval, { ...base, actionId: LOOP_REJECT_ACTION, channel: "C0OTHER", messageTs: "1.000001" })).toEqual({ kind: "forged" });
      expect(m.l.get(row.id)?.state).toBe("pending");
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
