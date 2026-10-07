import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "bin", "jarvis-run.sh");
const TICKET = "a".repeat(32);

/** Run the helper against a throwaway endpoint, returning what it did. */
const run = async (args: string[], env: Record<string, string> = {}) => {
  // The endpoint is a local server that echoes the payload back, so the test
  // sees exactly what the bot would have received.
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => new Response(await req.text(), { headers: { "content-type": "text/plain" } }),
  });
  try {
    const proc = Bun.spawn({
      cmd: ["bash", SCRIPT, `http://127.0.0.1:${server.port}/run`, ...args],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  } finally {
    server.stop(true);
  }
};

describe("jarvis-run.sh", () => {
  test("takes the ticket from the environment, never from the arguments", async () => {
    const { stdout, code } = await run(["ticket", "the", "webhook", "drops"], { JARVIS_RUN_TICKET: TICKET });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ticket: TICKET, line: "ticket the webhook drops" });
  });

  test("an old habit of passing one does not become part of the command", async () => {
    // a resumed session remembers the signature that took a ticket second, and
    // the ticket it remembers is dead - so it is dropped, not sent
    const stale = "b".repeat(32);
    const { stdout, code } = await run([stale, "ticket", "something"], { JARVIS_RUN_TICKET: TICKET });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ticket: TICKET, line: "ticket something" });
  });

  test("a word that merely looks like an argument is left alone", async () => {
    const { stdout } = await run(["bomb", "money", "9", "<link>"], { JARVIS_RUN_TICKET: TICKET });
    expect(JSON.parse(stdout).line).toBe("bomb money 9 <link>");
  });

  test("no ticket in the environment is refused, loudly", async () => {
    const { code, stderr } = await run(["ticket", "x"], { JARVIS_RUN_TICKET: "" });
    expect(code).toBe(3);
    expect(stderr).toContain("no ticket in this turn's environment");
  });

  test("a ticket but no command is a usage error, not an empty run", async () => {
    const { code } = await run([TICKET], { JARVIS_RUN_TICKET: TICKET });
    expect(code).toBe(2);
  });
});
