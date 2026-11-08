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
  orcaWorkerLiveness,
  parseAgentsList,
  type BackgroundLaunch,
  type BackgroundStopResult,
  type Liveness,
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

/** How many `worker-show` calls run at once. */
const CHECK_CONCURRENCY = 6;

type Checked = { launch: BackgroundLaunch; liveness: Liveness; reason: string };

/** `f` over `items`, at most `limit` at a time, results in input order. */
const mapLimited = async <T, R>(items: readonly T[], limit: number, f: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(f))));
  return out;
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

  /**
   * What each tool says about the launches: still going, gone, or it could
   * not tell (a CLI that failed, timed out or printed something else). A
   * failed check stays "unknown" so `stop` says so instead of "nothing is
   * running" while a session may still be editing files.
   */
  const checkAll = async (launches: readonly BackgroundLaunch[]): Promise<Checked[]> => {
    const bg = launches.filter((l) => l.kind === "claude-bg");
    const workers = launches.filter((l) => l.kind === "orca-worker");
    const checked: Checked[] = [];
    if (bg.length > 0) {
      const listed = await run([claude, "agents", "--json"]);
      const agents = listed.code === 0 ? parseAgentsList(listed.stdout) : undefined;
      if (!agents) {
        const reason = `\`claude agents\` failed: ${firstLine(listed)}`;
        checked.push(...bg.map((l) => ({ launch: l, liveness: "unknown" as const, reason })));
      } else {
        const alive = new Set(liveClaudeSessions(bg.map((l) => l.id), agents));
        checked.push(...bg.map((l) => ({ launch: l, liveness: alive.has(l.id) ? ("live" as const) : ("gone" as const), reason: "" })));
      }
    }
    // One `worker-show` per dispatch the thread ever started, a few at a time:
    // one by one, a long thread or a hung Orca kept the reply waiting minutes.
    checked.push(
      ...(await mapLimited(workers, CHECK_CONCURRENCY, async (w) => {
        // `worker-show` exits 1 on `dispatch_not_found` but still prints JSON.
        const shown = await run([orca, "orchestration", "worker-show", "--dispatch", w.id, "--json"]);
        const liveness = orcaWorkerLiveness(shown.stdout);
        return { launch: w, liveness, reason: liveness === "unknown" ? `\`worker-show\` failed: ${firstLine(shown)}` : "" };
      })),
    );
    return checked;
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
        const checked = await checkAll(launches);
        const allowed = (l: BackgroundLaunch): boolean => mayStopLaunch(l, actor, mayStopOthers);
        const live = checked.filter((c) => c.liveness === "live").map((c) => c.launch);
        const notYours = live.filter((l) => !allowed(l));
        const unchecked = checked
          .filter((c) => c.liveness === "unknown" && allowed(c.launch))
          .map((c) => ({ ...c.launch, reason: c.reason }));
        const stopped: BackgroundLaunch[] = [];
        const failed: (BackgroundLaunch & { reason: string })[] = [];
        for (const l of live.filter(allowed)) {
          const out = await stopOne(l);
          if (out.code === 0) stopped.push(l);
          else failed.push({ ...l, reason: firstLine(out) });
        }
        return { stopped, failed, notYours, unchecked };
      } catch {
        return NOTHING_IN_BACKGROUND;
      }
    },
  };
};
