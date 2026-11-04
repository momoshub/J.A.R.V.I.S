/**
 * Running a watch's predicate.
 *
 * A watch asks a yes/no question about the outside world - has the build
 * finished, is the image published, is the deploy green - and the only honest
 * general way to ask that on this host is a shell command's exit code. The
 * command is supplied by an admin (the `watch` command's role floor), runs as
 * the bot, and is bounded here rather than by its author.
 *
 * Output is kept only to show the last few lines back when the watch fires,
 * so it is capped: a predicate that prints a megabyte is still only answering
 * yes or no.
 */
import type { CheckResult } from "../../application/watcher.ts";
import { stopProcess } from "../llm/killTree.ts";

const MAX_OUTPUT = 4_000;

export const createShellCheck = (
  cwd?: string,
): ((cmd: string, timeoutMs: number) => Promise<CheckResult>) => {
  return async (cmd, timeoutMs) => {
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    try {
      proc = Bun.spawn({
        cmd: ["/bin/sh", "-c", cmd],
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        ...(cwd ? { cwd } : {}),
      });
      const timer = setTimeout(() => {
        // The whole tree: a predicate that pipes is several processes, and
        // killing only the shell leaves the rest holding the pipe open.
        if (proc) stopProcess(proc);
      }, timeoutMs);
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timer);
      const output = `${out}${err}`.slice(-MAX_OUTPUT);
      // 127 is "no such command", which is a broken watch rather than a "no".
      if (code === 127) return { code, output, error: output.trim().split("\n")[0] || "command not found" };
      return { code, output };
    } catch (e) {
      if (proc) stopProcess(proc);
      return { code: -1, output: "", error: e instanceof Error ? e.message : String(e) };
    }
  };
};
