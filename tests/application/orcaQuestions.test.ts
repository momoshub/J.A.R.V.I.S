import { beforeEach, describe, expect, test } from "bun:test";
import {
  createOrcaQuestionBridge,
  MAX_ATTEMPTS,
  ORCA_QUESTION_POLL_MS,
  type OrcaQuestionDeps,
} from "../../src/application/orcaQuestions.ts";
import type { BillingContext } from "../../src/application/ports.ts";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createOrcaQuestionRepo, type OrcaQuestionRepo } from "../../src/infrastructure/db/orcaQuestionRepo.ts";

const RUN = "run_aaaaaa";
const CTX = "ctx_bbbbbb";
const BILL: BillingContext = { actor: "U1", kind: "chat", channel: "C1", threadTs: "1.0" };
const THREAD = { channelId: "C1", threadTs: "1.0", slackUserId: "U1" };

const mailbox = (messages: object[]): string => JSON.stringify({ ok: true, result: { messages, count: messages.length } });
const QUESTION = {
  id: "msg_q1",
  type: "question",
  from_handle: `dispatch:${CTX}`,
  to_handle: `run:${RUN}`,
  thread_id: "msg_q1",
  payload: JSON.stringify({ dispatchId: CTX, taskId: "task_1", question: "stop or post?", options: [] }),
};
const LIVE = JSON.stringify({ ok: true, result: { stage: "running", state: "running" } });
const GONE = JSON.stringify({ ok: true, result: { stage: "settled" } });

let db: DbClient;
let repo: OrcaQuestionRepo;
let now: number;
let runBox: string;
let workerBox: string;
let workerShow: string;
let calls: string[][];
let turns: { channelId: string; threadTs: string; slackUserId: string; text: string; keepSession?: boolean; unprompted?: boolean }[];

const build = (over: Partial<OrcaQuestionDeps> = {}) =>
  createOrcaQuestionBridge({
    repo,
    clock: () => now,
    orca: async (args) => {
      calls.push([...args]);
      const target = args[args.indexOf("--terminal") + 1] ?? "";
      if (args[1] === "worker-show") return { code: 0, stdout: workerShow };
      return { code: 0, stdout: target.startsWith("run:") ? runBox : workerBox };
    },
    ready: async () => true,
    runTurn: async (r) => void turns.push(r),
    mayRun: () => true,
    ...over,
  });

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  db = openDatabase(":memory:");
  repo = createOrcaQuestionRepo(db);
  now = 1_000_000;
  runBox = mailbox([QUESTION]);
  workerBox = mailbox([QUESTION]);
  workerShow = LIVE;
  calls = [];
  turns = [];
});

describe("observe", () => {
  const start = `{"ok":true,"result":{"dispatchId":"${CTX}","taskId":"task_1","runId":"${RUN}"}}`;
  const bash = (command: string) => JSON.stringify({ command });

  test("a worker-start in a thread links its dispatch and Run to that thread", () => {
    const b = build();
    b.observe({ kind: "call", id: "t1", name: "Bash", input: bash(`orca orchestration worker-start --run ${RUN} --spec x --json`) }, BILL);
    b.observe({ kind: "result", id: "t1", isError: false, output: start }, BILL);
    expect(repo.threadOf(CTX)).toEqual(THREAD);
    expect(repo.threadOf(RUN)).toEqual(THREAD);
  });

  test("other calls, failed calls and threadless runs link nothing", () => {
    const b = build();
    b.observe({ kind: "call", id: "a", name: "Bash", input: bash(`cat log # orca orchestration worker-start`) }, BILL);
    b.observe({ kind: "result", id: "a", isError: false, output: start }, BILL);
    b.observe({ kind: "call", id: "b", name: "Bash", input: bash("orca orchestration worker-start --spec x") }, BILL);
    b.observe({ kind: "result", id: "b", isError: true, output: start }, BILL);
    b.observe({ kind: "call", id: "c", name: "Bash", input: bash("orca orchestration worker-start --spec x") }, { actor: "U1", kind: "chat" });
    b.observe({ kind: "result", id: "c", isError: false, output: start }, undefined);
    b.observe({ kind: "call", id: "d", name: "Read", input: bash("orca orchestration worker-start") }, BILL);
    b.observe({ kind: "result", id: "d", isError: false, output: start }, BILL);
    expect(repo.threadOf(CTX)).toBeUndefined();
  });
});

describe("tick", () => {
  beforeEach(() => {
    repo.link(CTX, THREAD, now);
    repo.link(RUN, THREAD, now);
  });

  test("a waiting question goes to its thread once, as whoever started the worker", async () => {
    const b = build();
    await b.tick();
    await flush();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ ...THREAD, keepSession: true, unprompted: true });
    expect(turns[0]?.text).toContain(`orca orchestration reply --id msg_q1 --run ${RUN}`);
    expect(repo.question("msg_q1")?.state).toBe("delivered");
    now += ORCA_QUESTION_POLL_MS;
    await b.tick();
    await flush();
    expect(turns).toHaveLength(1);
  });

  test("the mailbox is read at most once per poll interval", async () => {
    const b = build({ runTurn: () => new Promise(() => {}) });
    await b.tick();
    now += ORCA_QUESTION_POLL_MS - 1;
    await b.tick();
    expect(calls.filter((c) => c.includes(`run:${RUN}`))).toHaveLength(1);
  });

  test("a question whose turn is still running is not delivered again", async () => {
    let started = 0;
    const b = build({ runTurn: () => ((started += 1), new Promise(() => {})) });
    await b.tick();
    now += ORCA_QUESTION_POLL_MS;
    await b.tick();
    expect(started).toBe(1);
    expect(repo.question("msg_q1")).toMatchObject({ state: "delivering", attempts: 1 });
  });

  test("a delivery a dead process left half-done is picked up after a restart, while still unanswered", async () => {
    await build({ runTurn: () => new Promise(() => {}) }).tick();
    // the process dies; a new one starts on the same database
    repo = createOrcaQuestionRepo(db);
    now += ORCA_QUESTION_POLL_MS;
    await build().tick();
    await flush();
    expect(turns).toHaveLength(1);
    expect(repo.question("msg_q1")).toMatchObject({ state: "delivered", attempts: 2 });
  });

  test("it stops after MAX_ATTEMPTS cut deliveries", async () => {
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      await build({ runTurn: () => new Promise(() => {}) }).tick();
      now += ORCA_QUESTION_POLL_MS;
    }
    expect(repo.question("msg_q1")).toMatchObject({ state: "gave_up", attempts: MAX_ATTEMPTS });
  });

  test("a turn that fails to start is tried again on the next poll", async () => {
    let fail = true;
    const b = build({ runTurn: async (r) => { if (fail) throw new Error("queue full"); turns.push(r); } });
    await b.tick();
    await flush();
    expect(repo.question("msg_q1")?.state).toBe("delivering");
    fail = false;
    now += ORCA_QUESTION_POLL_MS;
    await b.tick();
    await flush();
    expect(turns).toHaveLength(1);
    expect(repo.question("msg_q1")).toMatchObject({ state: "delivered", attempts: 2 });
  });

  test("an answered question, or one whose worker is gone, gets no turn", async () => {
    workerBox = mailbox([QUESTION, { id: "msg_r", thread_id: "msg_q1" }]);
    await build().tick();
    expect(repo.question("msg_q1")?.state).toBe("answered");
    repo.settle("msg_q1", "delivering", now);
    workerBox = mailbox([QUESTION]);
    workerShow = GONE;
    now += ORCA_QUESTION_POLL_MS;
    await build().tick();
    await flush();
    expect(repo.question("msg_q1")?.state).toBe("closed");
    expect(turns).toHaveLength(0);
  });

  test("an unreadable mailbox decides nothing", async () => {
    workerBox = "";
    await build().tick();
    expect(repo.question("msg_q1")).toBeUndefined();
    runBox = "boom";
    workerBox = mailbox([QUESTION]);
    now += ORCA_QUESTION_POLL_MS;
    await build().tick();
    expect(repo.question("msg_q1")).toBeUndefined();
    expect(turns).toHaveLength(0);
  });

  test("a starter who may no longer run turns gets none", async () => {
    await build({ mayRun: () => false }).tick();
    expect(repo.question("msg_q1")?.state).toBe("refused");
    expect(turns).toHaveLength(0);
  });

  test("without its own Orca terminal it reads nothing, since no turn could reply", async () => {
    await build({ ready: async () => false }).tick();
    expect(calls).toHaveLength(0);
  });

  test("a worker whose own launch was not seen still finds the thread through its Run", async () => {
    runBox = mailbox([{ ...QUESTION, from_handle: "dispatch:ctx_ffffff", payload: JSON.stringify({ dispatchId: "ctx_ffffff", question: "?" }) }]);
    const fresh = createOrcaQuestionRepo(openDatabase(":memory:"));
    fresh.link("run_aaaaaa", THREAD, now);
    repo = fresh;
    await build().tick();
    await flush();
    expect(turns).toHaveLength(1);
  });

  test("Runs older than the window are not read", async () => {
    now += 4 * 24 * 60 * 60_000;
    await build().tick();
    expect(calls).toHaveLength(0);
  });
});
