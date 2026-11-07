import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "bin", "desktop.ts");

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desktop-lock-"));
  // a fake agent-desktop that just echoes what it was asked to do
  const fake = join(dir, "agent-desktop");
  writeFileSync(fake, "#!/bin/sh\necho \"ran $*\"\n");
  chmodSync(fake, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = async (session: string, args: string[]) => {
  const proc = Bun.spawn({
    cmd: ["bun", SCRIPT, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, BOT_SESSION_ID: session, JARVIS_DESKTOP_LOCK: join(dir, "lock") },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
};

describe("bin/desktop.ts", () => {
  test("a second session cannot click while the first holds the screen", async () => {
    const a = await run("s1", ["agent-desktop", "click", "@e3"]);
    expect(a.code).toBe(0);
    expect(a.stdout).toContain("ran click @e3");

    const b = await run("s2", ["agent-desktop", "launch", "Brave Browser"]);
    expect(b.code).toBe(75);
    expect(b.stdout).not.toContain("ran");
    expect(b.stderr).toContain("desktop busy: session s1");
  });

  test("the waiting session may still look, and `free` tells it when to go", async () => {
    await run("s1", ["agent-desktop", "click", "@e3"]);
    expect((await run("s2", ["agent-desktop", "snapshot", "--app", "Brave Browser"])).stdout).toContain("ran snapshot");
    expect((await run("s2", ["free"])).code).toBe(1);
    expect((await run("s1", ["free"])).code).toBe(0);
  });

  test("release hands it over, and only the holder can release", async () => {
    await run("s1", ["agent-desktop", "click", "@e3"]);
    expect((await run("s2", ["release"])).stdout).toContain("\"released\":false");
    expect((await run("s2", ["free"])).code).toBe(1);
    expect((await run("s1", ["release"])).stdout).toContain("\"released\":true");
    const b = await run("s2", ["agent-desktop", "click", "@e9"]);
    expect(b.code).toBe(0);
    expect(b.stdout).toContain("ran click @e9");
  });

  test("it runs only the two drivers, never an arbitrary program", async () => {
    const r = await run("s1", ["sh", "-c", "echo pwned"]);
    expect(r.code).toBe(2);
    expect(r.stdout).not.toContain("pwned");
  });
});
