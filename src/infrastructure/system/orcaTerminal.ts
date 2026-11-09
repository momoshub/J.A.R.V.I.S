/**
 * The bot's own Orca terminal - the sender every CLI turn orchestrates from.
 *
 * A turn runs as `claude -p` outside any Orca pane, so `orca orchestration
 * run-create` / `worker-start` refused it with `no_active_sender_terminal`:
 * Orca needs a sender handle (`--from`, or `ORCA_TERMINAL_HANDLE`). The
 * orchestration rules in the prompt could not work from Slack, and turns fell
 * back to the Agent tool, whose agents die with the turn.
 *
 * So the bot keeps one terminal of its own: created once, persisted so a
 * restart of the bot reuses it, checked against Orca at most once per TTL, and
 * re-created when Orca restarted (handles do not survive that) or the pane is
 * gone. Never another pane's handle. When Orca is not running the answer is
 * simply "no handle" and the turn's rules fall back to the Agent tool.
 */
import { stopProcess } from "../llm/killTree.ts";
import { ignoreQuietly } from "../../application/ignoredError.ts";

/** One `orca` call: its exit code and stdout. Never throws. */
export type OrcaRun = (args: readonly string[]) => Promise<{ code: number; stdout: string }>;

export type OrcaTerminalConfig = {
  run: OrcaRun;
  /** The handle kept from an earlier start, if any. */
  load: () => string | undefined;
  save: (handle: string) => void;
  /** Worktree selector the terminal is created in, e.g. `path:/Users/me/Workspaces`. */
  worktree: string;
  now: () => number;
  /** How long a checked handle - or a down runtime - is trusted before asking Orca again. */
  ttlMs?: number;
  log?: (line: string) => void;
};

export type OrcaTerminal = {
  /** The live handle, or undefined when Orca is not reachable. Never throws. */
  handle: () => Promise<string | undefined>;
};

export const ORCA_TERMINAL_TITLE = "jarvis-orchestrator";
export const ORCA_HANDLE_TTL_MS = 60_000;
export const ORCA_CALL_TIMEOUT_MS = 5_000;

type ShowResult = { ok?: boolean; result?: { terminal?: { handle?: unknown; orphaned?: unknown } } };

const parse = (stdout: string): ShowResult | undefined => {
  try {
    return JSON.parse(stdout) as ShowResult;
  } catch {
    return undefined;
  }
};

/**
 * What `orca terminal show --json` says about this handle: `live`, `gone`
 * (Orca answered and it is stale, orphaned or another terminal), or
 * `unknown` when Orca gave no answer at all - timed out, not running.
 */
export const handleState = (stdout: string, handle: string): "live" | "gone" | "unknown" => {
  const r = parse(stdout);
  if (!r || typeof r.ok !== "boolean") return "unknown";
  const t = r.ok ? r.result?.terminal : undefined;
  return t?.handle === handle && t.orphaned !== true ? "live" : "gone";
};

/** The handle `orca terminal create --json` issued, if it issued one. */
export const createdHandleOf = (stdout: string): string | undefined => {
  const r = parse(stdout);
  const h = r?.ok === true ? r.result?.terminal?.handle : undefined;
  return typeof h === "string" && h.startsWith("term_") ? h : undefined;
};

export const createOrcaTerminal = (config: OrcaTerminalConfig): OrcaTerminal => {
  const ttl = config.ttlMs ?? ORCA_HANDLE_TTL_MS;
  let known = config.load();
  let answer: string | undefined;
  let checkedAt: number | undefined;
  let inflight: Promise<string | undefined> | undefined;
  let failing = false;

  const settle = async (): Promise<string | undefined> => {
    if (known) {
      const shown = await config.run(["terminal", "show", "--terminal", known, "--json"]);
      const state = handleState(shown.stdout, known);
      if (state === "live" && shown.code === 0) return known;
      // No answer is not "gone": creating a second pane over a live one that
      // was only slow to answer would leak it.
      if (state === "unknown") return undefined;
    }
    const made = await config.run([
      "terminal", "create", "--worktree", config.worktree, "--title", ORCA_TERMINAL_TITLE, "--json",
    ]);
    const handle = made.code === 0 ? createdHandleOf(made.stdout) : undefined;
    // Not reachable: keep the old handle, it is still good if Orca was only busy.
    if (!handle) return undefined;
    known = handle;
    config.save(handle);
    config.log?.(`[orca] own terminal ${handle}`);
    return handle;
  };

  const handle = (): Promise<string | undefined> => {
    if (checkedAt !== undefined && config.now() - checkedAt < ttl) return Promise.resolve(answer);
    // Turns that start together share one check rather than each creating a pane.
    inflight ??= settle()
      .catch(ignoreQuietly("orca terminal check"))
      .then((h) => {
        // Said once when it stops working, not on every check while it is down.
        if (!h && !failing) config.log?.("[orca] no terminal of my own (Orca not running, or it refused the worktree); turns get no ORCA_TERMINAL_HANDLE");
        failing = !h;
        answer = h;
        checkedAt = config.now();
        inflight = undefined;
        return h;
      });
    return inflight;
  };

  return { handle };
};

/** `orca <args>` on the host, bounded so a hung runtime cannot hold a turn. */
export const createOrcaCli = (bin = "orca", timeoutMs = ORCA_CALL_TIMEOUT_MS): OrcaRun => async (args) => {
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined;
  try {
    proc = Bun.spawn({ cmd: [bin, ...args], stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const running = proc;
    const timer = setTimeout(() => stopProcess(running), timeoutMs);
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return { code, stdout };
  } catch {
    // no orca on PATH: the same as a runtime that is not running
    if (proc) stopProcess(proc);
    return { code: -1, stdout: "" };
  }
};
