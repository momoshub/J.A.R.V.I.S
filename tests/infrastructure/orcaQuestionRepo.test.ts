import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createOrcaQuestionRepo } from "../../src/infrastructure/db/orcaQuestionRepo.ts";

const T1 = { channelId: "C1", threadTs: "1.0", slackUserId: "U1" };
const T2 = { channelId: "C2", threadTs: "2.0", slackUserId: "U2" };
const Q = { messageId: "msg_1", runId: "run_aaaaaa", dispatchId: "ctx_bbbbbb" };

describe("orca question repo", () => {
  test("the first thread to name an id keeps it, across a restart", () => {
    const db = openDatabase(":memory:");
    const repo = createOrcaQuestionRepo(db);
    repo.link("run_aaaaaa", T1, 10);
    repo.link("run_aaaaaa", T2, 20);
    expect(createOrcaQuestionRepo(db).threadOf("run_aaaaaa")).toEqual(T1);
    expect(repo.threadOf("run_none")).toBeUndefined();
  });

  test("runsSince lists only Runs, newest first, inside the window", () => {
    const repo = createOrcaQuestionRepo(openDatabase(":memory:"));
    repo.link("run_old", T1, 5);
    repo.link("run_new", T1, 30);
    repo.link("ctx_bbbbbb", T1, 30);
    repo.link("run_mid", T1, 20);
    expect(repo.runsSince(10)).toEqual(["run_new", "run_mid"]);
  });

  test("a question is recorded once; retry counts, settle ends it", () => {
    const db = openDatabase(":memory:");
    const repo = createOrcaQuestionRepo(db);
    expect(repo.record(Q, T1, "delivering", 1)).toBe(true);
    expect(repo.record(Q, T1, "delivering", 2)).toBe(false);
    expect(repo.question("msg_1")).toEqual({ ...Q, state: "delivering", attempts: 1 });
    expect(repo.retry("msg_1", 3)).toBe(2);
    repo.settle("msg_1", "delivered", 4);
    expect(createOrcaQuestionRepo(db).question("msg_1")?.state).toBe("delivered");
    expect(repo.record({ ...Q, messageId: "msg_2" }, T1, "closed", 5)).toBe(true);
    expect(repo.question("msg_2")).toEqual({ ...Q, messageId: "msg_2", state: "closed", attempts: 0 });
  });

  test("askingDispatches lists dispatches with a question still waiting, once each", () => {
    const repo = createOrcaQuestionRepo(openDatabase(":memory:"));
    repo.record({ messageId: "m1", runId: "run_a", dispatchId: "ctx_waiting" }, T1, "delivering", 1);
    repo.record({ messageId: "m2", runId: "run_a", dispatchId: "ctx_waiting" }, T1, "delivered", 1);
    repo.record({ messageId: "m3", runId: "run_a", dispatchId: "ctx_done" }, T1, "delivered", 1);
    repo.settle("m3", "answered", 2);
    repo.record({ messageId: "m4", runId: "run_a", dispatchId: "ctx_closed" }, T1, "closed", 1);
    expect(repo.askingDispatches()).toEqual(["ctx_waiting"]);
  });
});
