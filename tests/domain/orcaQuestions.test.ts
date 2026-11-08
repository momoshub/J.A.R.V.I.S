import { describe, expect, test } from "bun:test";
import {
  answeredIn,
  ORCA_QUESTION_TAG,
  QUESTION_CHARS,
  questionsIn,
  questionTurnText,
  workerLinksIn,
} from "../../src/domain/orcaQuestions.ts";

const START = `RUN=run_2543a633a2dc
{"ok":true,"result":{"dispatchId":"ctx_0b5c88964b58","taskId":"task_d57f65182ca2","runId":"run_2543a633a2dc","state":"ready"}}`;

const mailbox = (messages: object[]): string => JSON.stringify({ id: "x", ok: true, result: { messages, count: messages.length } });

const question = (over: Record<string, unknown> = {}) => ({
  id: "msg_56b31ec3a799",
  run_id: "run_ba4d4d4f68dc",
  type: "question",
  from_handle: "dispatch:ctx_1388304a35aa",
  to_handle: "run:run_ba4d4d4f68dc",
  subject: "Question",
  body: "preview",
  thread_id: "msg_56b31ec3a799",
  payload: JSON.stringify({ taskId: "task_e73159fe7f3c", dispatchId: "ctx_1388304a35aa", question: "stop or post?", options: ["stop", "post"] }),
  ...over,
});

describe("workerLinksIn", () => {
  test("pairs the dispatch and Run a worker-start printed", () => {
    expect(workerLinksIn(START)).toEqual([{ runId: "run_2543a633a2dc", dispatchId: "ctx_0b5c88964b58" }]);
  });

  test("either key order, each worker once", () => {
    const out = `{"runId":"run_aaaaaa","dispatchId":"ctx_bbbbbb"}\n{"dispatchId":"ctx_bbbbbb","runId":"run_aaaaaa"}\n{"dispatchId":"ctx_cccccc","runId":"run_aaaaaa"}`;
    expect(workerLinksIn(out)).toEqual([
      { runId: "run_aaaaaa", dispatchId: "ctx_bbbbbb" },
      { runId: "run_aaaaaa", dispatchId: "ctx_cccccc" },
    ]);
  });

  test("ids in different objects are never paired", () => {
    expect(workerLinksIn(`{"dispatchId":"ctx_bbbbbb"} {"runId":"run_aaaaaa"}`)).toEqual([]);
    expect(workerLinksIn("dispatch ctx_bbbbbb on run_aaaaaa")).toEqual([]);
  });
});

describe("questionsIn", () => {
  test("reads a question addressed to the Run, oldest first", () => {
    const older = question({ id: "msg_old", payload: JSON.stringify({ dispatchId: "ctx_1388304a35aa", question: "first" }) });
    const out = questionsIn(mailbox([question(), older]), "run_ba4d4d4f68dc");
    expect(out?.map((q) => q.id)).toEqual(["msg_old", "msg_56b31ec3a799"]);
    expect(out?.[1]).toEqual({
      id: "msg_56b31ec3a799",
      runId: "run_ba4d4d4f68dc",
      dispatchId: "ctx_1388304a35aa",
      taskId: "task_e73159fe7f3c",
      question: "stop or post?",
      options: ["stop", "post"],
    });
  });

  test("skips other types, other Runs, and falls back to the sender and body", () => {
    const out = questionsIn(
      mailbox([
        question({ type: "worker_done" }),
        question({ id: "msg_other", to_handle: "run:run_other" }),
        question({ id: "msg_bare", payload: null }),
      ]),
      "run_ba4d4d4f68dc",
    );
    expect(out).toEqual([
      { id: "msg_bare", runId: "run_ba4d4d4f68dc", dispatchId: "ctx_1388304a35aa", taskId: "", question: "preview", options: [] },
    ]);
  });

  test("output that is not a mailbox is no answer, not an empty one", () => {
    expect(questionsIn("", "run_x")).toBeUndefined();
    expect(questionsIn(JSON.stringify({ ok: false, error: { code: "x" } }), "run_x")).toBeUndefined();
    expect(questionsIn(mailbox([]), "run_x")).toEqual([]);
  });
});

describe("answeredIn", () => {
  test("a message threaded on the question is its answer; the question itself is not", () => {
    expect(answeredIn(mailbox([question()]), "msg_56b31ec3a799")).toBe(false);
    expect(answeredIn(mailbox([question(), { id: "msg_r", thread_id: "msg_56b31ec3a799" }]), "msg_56b31ec3a799")).toBe(true);
    expect(answeredIn("nope", "msg_56b31ec3a799")).toBeUndefined();
  });
});

describe("questionTurnText", () => {
  test("names the exact reply and never waits on the thread", () => {
    const [q] = questionsIn(mailbox([question()]), "run_ba4d4d4f68dc") ?? [];
    if (!q) throw new Error("no question");
    const text = questionTurnText(q);
    expect(text.startsWith(ORCA_QUESTION_TAG)).toBe(true);
    expect(text).toContain("orca orchestration reply --id msg_56b31ec3a799 --run run_ba4d4d4f68dc");
    expect(text).toContain("stop or post?");
    expect(text).toContain("stop | post");
    expect(text).toContain("pick the safe option");
  });

  test("a huge question is clipped", () => {
    const text = questionTurnText({ id: "m", runId: "r", dispatchId: "d", taskId: "", question: "x".repeat(QUESTION_CHARS + 50), options: [] });
    expect(text).toContain("[clipped 50 chars]");
  });
});
