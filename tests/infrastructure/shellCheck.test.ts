import { describe, expect, test } from "bun:test";
import { createShellCheck } from "../../src/infrastructure/system/shellCheck.ts";

describe("shell check", () => {
  test("runs a predicate and reports its exit code and output", async () => {
    const check = createShellCheck();
    expect(await check("echo hi; exit 0", 5_000)).toEqual({ code: 0, output: "hi\n" });
    expect((await check("exit 3", 5_000)).code).toBe(3);
  });

  test("a read-only Slack ticket reaches the predicate for the length of one run, and no longer", async () => {
    const events: string[] = [];
    const check = createShellCheck(undefined, () => {
      events.push("issued");
      return { env: { JARVIS_SLACK_TICKET: "jvsl_one-check" }, done: () => void events.push("done") };
    });
    const res = await check('echo "[$JARVIS_SLACK_TICKET]"', 5_000);
    expect(res.output).toBe("[jvsl_one-check]\n");
    expect(events).toEqual(["issued", "done"]);
    // a second run asks again rather than reusing the first
    await check("true", 5_000);
    expect(events).toEqual(["issued", "done", "issued", "done"]);
  });

  test("the ticket is handed back even when the predicate fails to run", async () => {
    const events: string[] = [];
    const check = createShellCheck("/nonexistent-dir-for-test", () => ({ env: {}, done: () => void events.push("done") }));
    const res = await check("true", 5_000);
    expect(res.code).toBe(-1);
    expect(events).toEqual(["done"]);
  });
});
