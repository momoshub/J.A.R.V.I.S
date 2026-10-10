/**
 * Ask the desktop whether we are allowed to drive it.
 *
 * The cheapest question that exercises the real permission: count the running
 * processes via System Events. It touches nothing, takes about 50ms, and fails
 * with the permission error when the grant is absent - which is the whole point.
 *
 * Cached, because the answer only changes when a human changes it (or a package
 * upgrade moves the binary out from under the grant), and re-probed on a TTL so
 * a health check reports something current rather than something from boot.
 */
import { readUiAccess, type UiAccess } from "../../domain/uiAccess.ts";

export type UiAccessReport = {
  access: UiAccess;
  /** When this was last established, epoch ms. */
  checkedAt: number;
};

export type UiAccessProbe = {
  /** The current answer, re-probing when the cached one has gone stale. */
  read: () => Promise<UiAccessReport>;
};

const PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_TTL_MS = 300_000;

const run = async (): Promise<{ exitCode: number; stderr: string }> => {
  try {
    const proc = Bun.spawn({
      cmd: ["osascript", "-e", 'tell application "System Events" to count processes'],
      stdout: "ignore",
      stderr: "pipe",
      timeout: PROBE_TIMEOUT_MS,
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, stderr };
  } catch (err) {
    // No osascript, or it could not be spawned at all. That is "unknown", not
    // "denied" - saying someone forgot a permission they never needed is worse
    // than saying nothing.
    return { exitCode: -1, stderr: err instanceof Error ? err.message : String(err) };
  }
};

export const createUiAccessProbe = (
  ttlMs: number = DEFAULT_TTL_MS,
  now: () => number = () => Date.now(),
): UiAccessProbe => {
  let cached: UiAccessReport | undefined;
  let inFlight: Promise<UiAccessReport> | undefined;

  const probe = async (): Promise<UiAccessReport> => {
    const report = { access: readUiAccess(await run()), checkedAt: now() };
    cached = report;
    return report;
  };

  return {
    read: async () => {
      if (cached && now() - cached.checkedAt < ttlMs) return cached;
      // One probe at a time: a burst of health checks should not become a burst
      // of subprocesses.
      inFlight ??= probe().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
};
