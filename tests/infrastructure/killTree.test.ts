import { describe, expect, test } from "bun:test";
import { killTree, stopProcess } from "../../src/infrastructure/llm/killTree.ts";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleepers = async (): Promise<number[]> => {
  const out = Bun.spawnSync({ cmd: ["pgrep", "-f", "sleep 31700"], stdout: "pipe", stderr: "ignore" });
  return new TextDecoder()
    .decode(out.stdout)
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
};

describe("killTree", () => {
  test("it kills grandchildren, which a plain kill leaves running", async () => {
    // measured: proc.kill() on a shell blocked waiting for its children left
    // the parent at exitCode null and two sleeps orphaned. That is a turn that
    // survives its own stop button.
    const proc = Bun.spawn({ cmd: ["sh", "-c", "sleep 31700 & sleep 31700"], stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(300);
    expect((await sleepers()).length).toBeGreaterThan(0);

    killTree(proc.pid!, "SIGKILL");
    await Bun.sleep(400);

    expect(await sleepers()).toEqual([]);
    expect(alive(proc.pid!)).toBe(false);
  });

  test("killing a pid that is already gone is not an error", () => {
    const proc = Bun.spawn({ cmd: ["true"], stdout: "ignore", stderr: "ignore" });
    const pid = proc.pid!;
    expect(() => killTree(pid, "SIGKILL")).not.toThrow();
    expect(() => killTree(pid, "SIGKILL")).not.toThrow();
  });

  test("it refuses to signal init, whatever it is handed", () => {
    expect(() => killTree(1, "SIGKILL")).not.toThrow();
    expect(() => killTree(0, "SIGKILL")).not.toThrow();
    expect(() => killTree(-1, "SIGKILL")).not.toThrow();
  });
});

describe("stopProcess", () => {
  test("a process that IGNORES SIGTERM still dies", async () => {
    // this is the production case exactly: the wedged turn sat at 0% CPU with
    // no children, shrugged off SIGTERM, and only went down on SIGKILL - 26
    // minutes and four stop presses after it was first asked to stop
    const proc = Bun.spawn({
      cmd: ["bun", "-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      stdout: "ignore",
      stderr: "ignore",
    });
    await Bun.sleep(700);
    const pid = proc.pid!;
    expect(alive(pid)).toBe(true);

    stopProcess(proc as unknown as { pid?: number; kill: () => void; exitCode: number | null }, 300);
    await Bun.sleep(1200);

    expect(alive(pid)).toBe(false);
  });
});
