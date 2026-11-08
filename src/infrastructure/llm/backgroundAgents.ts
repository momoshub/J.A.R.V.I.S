/**
 * Stops the background agents a thread's turns started outside their own
 * process tree: `claude --bg` sessions and Orca workers.
 *
 * Which ones are the thread's comes from its tool trace (see
 * `domain/threadBackground.ts`); whether each is still going, and stopping it,
 * goes through the tool's own CLI - `claude agents --json` + `claude stop <id>`,
 * `orca orchestration worker-show` + `worker-stop`. Nothing here signals a pid,
 * so it cannot reach a person's interactive session, another thread's
 * `claude -p`, the gateway or the bot itself: the only ids it ever acts on are
 * ones this thread's own launch commands printed.
 */
import type { BackgroundAgentsPort } from "../../application/ports.ts";
import {
  backgroundLaunches,
  liveClaudeSessions,
  mayStopLaunch,
  NOTHING_IN_BACKGROUND,
  orcaWorkerLive,
  parseAgentsList,
  type BackgroundLaunch,
  type BackgroundStopResult,
} from "../../domain/threadBackground.ts";
import { readThreadTrace } from "./toolTraceLog.ts";

export type CommandOutcome = { code: number; stdout: string; stderr: string };
/** Runs one command; must resolve (code -1 on a spawn failure), never reject. */
export type CommandRunner = (cmd: readonly string[]) => Promise<CommandOutcome>;

/** How much of a thread's trace is searched for launches. Stop is rare; a long thread is not. */
export const BACKGROUND_TRACE_BYTES = 16 * 1024 * 1024;
/** Per CLI call. `claude agents --json` takes ~1.5s here. */
const CALL_TIMEOUT_MS = 15_000;

export const defaultRunner =
  (cwd?: string): CommandRunner =>
  async (cmd) => {
    try {
      const proc = Bun.spawn({ cmd: [...cmd], cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const timer = setTimeout(() => proc.kill(), CALL_TIMEOUT_MS);
      timer.unref?.();
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timer);
      return { code, stdout, stderr };
    } catch (err) {
      return { code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
  };

const firstLine = (o: CommandOutcome): string =>
  (o.stderr.trim() || o.stdout.trim() || `exit ${o.code}`).split("\n")[0]?.slice(0, 120) ?? `exit ${o.code}`;

export const createBackgroundAgents = (opts: {
  /** `<LOG_DIR>/threads`, where the per-thread traces live. */
  traceDir: string;
  claudeBin?: string;
  orcaBin?: string;
  run?: CommandRunner;
  tailBytes?: number;
}): BackgroundAgentsPort => {
  const claude = opts.claudeBin ?? "claude";
  const orca = opts.orcaBin ?? "orca";
  const run = opts.run ?? defaultRunner();

  /** The launches of one kind that are still going, per the tool itself. */
  const liveOf = async (launches: readonly BackgroundLaunch[]): Promise<BackgroundLaunch[]> => {
    const bg = launches.filter((l) => l.kind === "claude-bg");
    const workers = launches.filter((l) => l.kind === "orca-worker");
    const live: BackgroundLaunch[] = [];
    if (bg.length > 0) {
      const listed = await run([claude, "agents", "--json"]);
      const alive = new Set(liveClaudeSessions(bg.map((l) => l.id), listed.code === 0 ? parseAgentsList(listed.stdout) : []));
      live.push(...bg.filter((l) => alive.has(l.id)));
    }
    for (const w of workers) {
      const shown = await run([orca, "orchestration", "worker-show", "--dispatch", w.id, "--json"]);
      if (shown.code === 0 && orcaWorkerLive(shown.stdout)) live.push(w);
    }
    return live;
  };

  const stopOne = async (l: BackgroundLaunch): Promise<CommandOutcome> =>
    l.kind === "claude-bg"
      ? run([claude, "stop", l.id])
      : run([orca, "orchestration", "worker-stop", "--dispatch", l.id, "--json"]);

  return {
    stopForThread: async ({ channelId, threadTs, actor, mayStopOthers }): Promise<BackgroundStopResult> => {
      try {
        const launches = backgroundLaunches(
          readThreadTrace(opts.traceDir, channelId, threadTs, opts.tailBytes ?? BACKGROUND_TRACE_BYTES),
        );
        if (launches.length === 0) return NOTHING_IN_BACKGROUND;
        const live = await liveOf(launches);
        const mine = live.filter((l) => mayStopLaunch(l, actor, mayStopOthers));
        const notYours = live.filter((l) => !mayStopLaunch(l, actor, mayStopOthers));
        const stopped: BackgroundLaunch[] = [];
        const failed: (BackgroundLaunch & { reason: string })[] = [];
        for (const l of mine) {
          const out = await stopOne(l);
          if (out.code === 0) stopped.push(l);
          else failed.push({ ...l, reason: firstLine(out) });
        }
        return { stopped, failed, notYours };
      } catch {
        return NOTHING_IN_BACKGROUND;
      }
    },
  };
};
