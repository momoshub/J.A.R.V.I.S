import { describe, expect, test } from "bun:test";
import {
  CONTINUE_MARKER,
  createMarkerFilter,
  failedStepNotice,
  parseContinue,
  pausedNotice,
} from "../../src/domain/workflowContinue.ts";
import { workflowPrompt } from "../../src/domain/workflowPrompt.ts";

describe("parseContinue", () => {
  test("a marker line asks to continue and is taken out", () => {
    const out = parseContinue("phase 5: scaffolded the layout, tests pass.\nnext: open the PR\n[continue]");
    expect(out.wantsContinue).toBe(true);
    expect(out.text).toBe("phase 5: scaffolded the layout, tests pass.\nnext: open the PR");
  });

  test("no marker, no continue, text untouched", () => {
    const out = parseContinue("done - PR is merged.");
    expect(out).toEqual({ text: "done - PR is merged.", wantsContinue: false });
  });

  test("tolerates case, padding, and code or emphasis wrapping", () => {
    for (const line of ["  [CONTINUE]  ", "`[continue]`", "*[continue]*", "_[Continue]_"]) {
      const out = parseContinue(`did a thing\n${line}`);
      expect(out.wantsContinue).toBe(true);
      expect(out.text).toBe("did a thing");
    }
  });

  test("a marker inside a sentence is not a request, but is still hidden", () => {
    const out = parseContinue("I will not write [continue] here because I need you to pick A or B?");
    expect(out.wantsContinue).toBe(false);
    expect(out.text).not.toContain(CONTINUE_MARKER);
  });

  test("a reply that is only the marker leaves nothing to post", () => {
    expect(parseContinue("\n[continue]\n")).toEqual({ text: "", wantsContinue: true });
  });
});

describe("createMarkerFilter", () => {
  const run = (deltas: string[]): string => {
    const f = createMarkerFilter();
    return deltas.map((d) => f.push(d)).join("") + f.flush();
  };

  test("drops a marker split across deltas", () => {
    expect(run(["step done.\n[con", "tin", "ue]"])).toBe("step done.\n");
  });

  test("releases a held fragment that turned out not to be the marker", () => {
    expect(run(["see [co", "de] here"])).toBe("see [code] here");
    expect(run(["ends with [c"])).toBe("ends with [c");
  });

  test("passes ordinary text straight through", () => {
    const f = createMarkerFilter();
    expect(f.push("hello world")).toBe("hello world");
    expect(f.flush()).toBe("");
  });
});

describe("prompt and notice", () => {
  test("the workflow prompt explains the marker and when not to use it", () => {
    const p = workflowPrompt("Evie", "rebuild the blog");
    expect(p).toContain(CONTINUE_MARKER);
    expect(p).toMatch(/ONE meaningful step/);
    expect(p).toMatch(/Do NOT add that line when you have asked a question/);
  });

  test("the workflow worker spawns agents as Orca workers and waits across steps", () => {
    const p = workflowPrompt("Evie", "rebuild the blog");
    expect(p).toContain("Pick the run mode by the job's weight, never by habit");
    expect(p).toContain("never through the Workflow tool");
    expect(p).toContain("orca orchestration run-create");
    expect(p).toContain("run the done check at the start of the next step");
    expect(p).toContain("never with a watch");
    expect(p).toContain("foreground loop of up to 5 minutes");
    // the self-fix reviewer is waited on the same way, never in a loop that dies with the step
    expect(p).toContain("The same holds for the reviewer on your own fix");
  });

  test("the paused notice says how to resume", () => {
    const n = pausedNotice(30, "//jv");
    expect(n).toContain("30");
    expect(n).toContain("carry on");
    expect(n).toContain("//jv workflow stop");
  });
});

describe("failedStepNotice", () => {
  test("names the error's first line and says what happens next", () => {
    const retry = failedStepNotice("claude CLI exited with code 143\nstack...", true, "//jv");
    expect(retry).toContain("code 143");
    expect(retry).not.toContain("stack");
    expect(retry).toContain("retrying once");
    const stopped = failedStepNotice("", false, "//jv");
    expect(stopped).toContain("unknown error");
    expect(stopped).toContain("//jv workflow stop");
  });
});
